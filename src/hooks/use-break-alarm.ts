"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AlarmSettings = {
  /** Minutes of work before the alarm fires. */
  intervalMin: number;
  /** Minutes of break once it does. */
  breakMin: number;
  sound: boolean;
  notify: boolean;
};

export const DEFAULT_SETTINGS: AlarmSettings = {
  intervalMin: 50,
  breakMin: 10,
  sound: true,
  notify: true,
};

const SETTINGS_KEY = "hours:alarm-settings";
const DEADLINE_KEY = "hours:alarm-deadline";

function readSettings(): AlarmSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AlarmSettings>;
    return {
      intervalMin:
        typeof parsed.intervalMin === "number" && parsed.intervalMin > 0
          ? parsed.intervalMin
          : DEFAULT_SETTINGS.intervalMin,
      breakMin:
        typeof parsed.breakMin === "number" && parsed.breakMin > 0
          ? parsed.breakMin
          : DEFAULT_SETTINGS.breakMin,
      sound: parsed.sound ?? DEFAULT_SETTINGS.sound,
      notify: parsed.notify ?? DEFAULT_SETTINGS.notify,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * A short two-tone chime built with the Web Audio API.
 *
 * Synthesised rather than shipped as an audio file so the alarm has no network
 * dependency — it has to fire reliably at minute 50 of a focus session, which
 * is exactly when a fetch is least welcome. The context is created lazily
 * because browsers only allow it after a user gesture.
 */
function useChime() {
  const ctxRef = useRef<AudioContext | null>(null);

  return useCallback(() => {
    try {
      type WithWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };
      const Ctor = window.AudioContext ?? (window as WithWebkit).webkitAudioContext;
      if (!Ctor) return;
      if (!ctxRef.current) ctxRef.current = new Ctor();
      const ctx = ctxRef.current;
      if (ctx.state === "suspended") void ctx.resume();

      const now = ctx.currentTime;
      // Two soft sine notes; a gain envelope avoids the click a raw
      // start/stop produces.
      [880, 1320].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const t0 = now + i * 0.18;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.34);
      });
    } catch {
      // Audio is a nicety; never let it break the timer.
    }
  }, []);
}

export type BreakAlarm = {
  settings: AlarmSettings;
  setSettings: (next: Partial<AlarmSettings>) => void;
  /** When the next alarm is due, or null when nothing is scheduled. */
  deadline: number | null;
  /** True once the alarm has fired and is waiting to be dealt with. */
  fired: boolean;
  /** Schedule (or reschedule) the next alarm from now. */
  arm: () => void;
  /** Stop scheduling entirely — nothing is running. */
  disarm: () => void;
  /** Clear the fired flag and start the next work interval. */
  acknowledge: () => void;
  notifyPermission: NotificationPermission | "unsupported";
  requestNotify: () => Promise<void>;
  /** Play the chime on demand, e.g. a "test sound" button. */
  testChime: () => void;
};

/**
 * Drives the every-X-minutes break alarm.
 *
 * The deadline is an absolute timestamp persisted to localStorage rather than
 * a countdown held in memory: a reload mid-session, or a laptop asleep past
 * the deadline, must still produce an alarm rather than silently restarting
 * the interval.
 */
export function useBreakAlarm(active: boolean, onFire?: () => void): BreakAlarm {
  const [settings, setSettingsState] = useState<AlarmSettings>(DEFAULT_SETTINGS);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [fired, setFired] = useState(false);
  const [notifyPermission, setNotifyPermission] = useState<
    NotificationPermission | "unsupported"
  >("unsupported");
  const chime = useChime();

  // Latest-callback ref so re-arming doesn't depend on the caller memoising.
  const onFireRef = useRef(onFire);
  useEffect(() => {
    onFireRef.current = onFire;
  }, [onFire]);

  // Hydrate from storage after mount so the server render stays stable.
  // localStorage cannot be read during SSR, so applying stored values on mount
  // is the entire point: the server and first client render must agree on the
  // defaults, and the real values can only land afterwards. Runs exactly once,
  // so there is no cascade for the rule to protect against.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSettingsState(readSettings());
    const raw = window.localStorage.getItem(DEADLINE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) setDeadline(parsed);
    setNotifyPermission(
      typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    );
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const setSettings = useCallback((next: Partial<AlarmSettings>) => {
    setSettingsState((prev) => {
      const merged = { ...prev, ...next };
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
      } catch {
        // Private mode / storage full: settings just won't persist.
      }
      return merged;
    });
  }, []);

  const writeDeadline = useCallback((value: number | null) => {
    setDeadline(value);
    try {
      if (value === null) window.localStorage.removeItem(DEADLINE_KEY);
      else window.localStorage.setItem(DEADLINE_KEY, String(value));
    } catch {
      // Non-fatal; the in-memory deadline still drives this session.
    }
  }, []);

  const arm = useCallback(() => {
    setFired(false);
    writeDeadline(Date.now() + settings.intervalMin * 60_000);
  }, [settings.intervalMin, writeDeadline]);

  const disarm = useCallback(() => {
    setFired(false);
    writeDeadline(null);
  }, [writeDeadline]);

  const acknowledge = useCallback(() => {
    arm();
  }, [arm]);

  // Arming is left to the caller (arm on start, disarm on stop) rather than
  // driven by an effect watching `active`. Starting and stopping work are
  // events, and reacting to them here meant an effect whose only job was to
  // push state around — with the extra hazard that arm() resets the very
  // values the effect would have to depend on.

  // The tick. One second is plenty for a minutes-scale alarm and keeps the
  // ring in sync with the countdown the user sees.
  useEffect(() => {
    if (!active || deadline === null || fired) return;
    const check = () => {
      if (Date.now() < deadline) return;
      // Firing is an event, not state being synchronised: the callback lets
      // the caller snapshot what was running at this instant rather than
      // reacting to `fired` in an effect of its own.
      setFired(true);
      onFireRef.current?.();
    };
    // A deadline already in the past (laptop asleep through it, or a reload
    // after the fact) must still fire, so check immediately as well as on the
    // interval. This is a timer callback, not an effect body — no cascade.
    const id = setInterval(check, 1000);
    check();
    return () => clearInterval(id);
  }, [active, deadline, fired]);

  // Announce exactly once per firing.
  const announcedRef = useRef(false);
  useEffect(() => {
    if (!fired) {
      announcedRef.current = false;
      return;
    }
    if (announcedRef.current) return;
    announcedRef.current = true;

    if (settings.sound) chime();
    if (settings.notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification("time for a break", {
          body: "what did you get done?",
          tag: "hours-break",
        });
      } catch {
        // Some browsers throw for notifications outside a service worker.
      }
    }
  }, [fired, settings.sound, settings.notify, chime]);

  const requestNotify = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setNotifyPermission(result);
  }, []);

  return {
    settings,
    setSettings,
    deadline,
    fired,
    arm,
    disarm,
    acknowledge,
    notifyPermission,
    requestNotify,
    testChime: chime,
  };
}
