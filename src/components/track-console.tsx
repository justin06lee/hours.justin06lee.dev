"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Play, Square, Plus, Settings2, Volume2, Bell, X } from "lucide-react";
import Select from "@/components/chrome/select";
import { Input } from "@/components/chrome/input";
import { Textarea } from "@/components/chrome/textarea";
import { Button } from "@/components/chrome/button";
import { LaneBar } from "@/components/chrome/lane-bar";
import { TimerRing } from "@/components/chrome/timer-ring";
import { BreakOverlay } from "@/components/chrome/break-overlay";
import { IntervalPicker } from "@/components/chrome/interval-picker";
import { ToastProvider, useToast } from "@/components/chrome/toast";
import { useBreakAlarm } from "@/hooks/use-break-alarm";
import type { CalendarActual } from "@/lib/calendar";
import type { CalendarCategory } from "@/lib/calendar-categories";
import { MAX_TRACK, PRIMARY_TRACK } from "@/lib/calendar-constants";
import { segmentLanes, startLane, startLanes, stopAllLanes, stopLane } from "@/app/actions";
import { cn } from "@/lib/utils";

type Draft = { categoryId: string; title: string };

/** What the "what did you do?" dialog collects, per running lane. */
type Segment = { id: string; track: number; categoryId: string | null; title: string | null };

export function TrackConsole(props: {
  categories: CalendarCategory[];
  initialLanes: CalendarActual[];
}) {
  return (
    <ToastProvider position="bottom-right" anchor="viewport">
      <Console {...props} />
    </ToastProvider>
  );
}

function Console({
  categories,
  initialLanes,
}: {
  categories: CalendarCategory[];
  initialLanes: CalendarActual[];
}) {
  const [lanes, setLanes] = useState<CalendarActual[]>(initialLanes);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  // Lanes the user has opened but not started yet. Lane 0 always exists.
  const [openLanes, setOpenLanes] = useState<number[]>(() => {
    const running = initialLanes.map((l) => l.track);
    return running.length > 0 ? [...new Set([0, ...running])].sort((a, b) => a - b) : [0];
  });
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});

  const anyRunning = lanes.length > 0;

  // The alarm has fired: collect descriptions before anything is closed.
  const [prompting, setPrompting] = useState<Segment[] | null>(null);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [onBreak, setOnBreak] = useState(false);
  const [resumeAfterBreak, setResumeAfterBreak] = useState<Segment[]>([]);

  const active = categories.filter((c) => !c.archived);
  const options = useMemo(
    () => [
      { value: "", label: "no subject" },
      ...active.map((c) => ({
        value: c.id,
        label: c.name.toLowerCase(),
        prefix: (
          <span aria-hidden className="size-2 shrink-0" style={{ background: c.color }} />
        ),
      })),
    ],
    [active],
  );

  const colorOf = useMemo(
    () => new Map(categories.map((c) => [c.id, c.color])),
    [categories],
  );
  const nameOf = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );

  const draftFor = (track: number): Draft => drafts[track] ?? { categoryId: "", title: "" };
  const setDraft = (track: number, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [track]: { ...draftFor(track), ...patch } }));

  const runningOn = useCallback(
    (track: number) => lanes.find((l) => l.track === track),
    [lanes],
  );

  const apply = useCallback(
    (result: Awaited<ReturnType<typeof startLane>>) => {
      if (result.ok) setLanes(result.lanes);
      else toast({ title: result.error, variant: "danger" });
      return result.ok;
    },
    [toast],
  );

  const handleStart = (track: number) => {
    const d = draftFor(track);
    startTransition(async () => {
      const result = await startLane({
        track,
        categoryId: d.categoryId || null,
        title: d.title.trim() || null,
      });
      if (!apply(result)) return;
      toast({ title: `lane ${track} started`, variant: "success" });
      // Only the first lane starts the clock; opening a second lane mid-stretch
      // must not push the break further away.
      if (alarm.deadline === null) alarm.arm();
    });
  };

  const handleStop = (id: string) => {
    startTransition(async () => {
      const result = await stopLane({ id });
      if (!apply(result)) return;
      toast({ title: "logged", variant: "success" });
      // Last lane down ends the session, so stop counting toward a break.
      if (result.lanes.length === 0) alarm.disarm();
    });
  };

  const handleStopAll = () => {
    startTransition(async () => {
      const ok = apply(await stopAllLanes());
      if (ok) {
        alarm.disarm();
        toast({ title: "session ended", variant: "success" });
      }
    });
  };

  // What's running right now, readable from the alarm callback without making
  // the alarm depend on every lane change.
  const lanesRef = useRef(lanes);
  useEffect(() => {
    lanesRef.current = lanes;
  }, [lanes]);

  // Snapshot the running lanes at the instant the alarm fires. A snapshot
  // rather than derived state because submitting closes those lanes, which
  // would empty a derived list out from under the dialog mid-answer.
  const handleAlarm = useCallback(() => {
    const running = lanesRef.current;
    if (running.length === 0) return;
    setPrompting((prev) =>
      prev ??
      running.map((l) => ({
        id: l.id,
        track: l.track,
        categoryId: l.categoryId,
        title: l.title,
      })),
    );
  }, []);

  const alarm = useBreakAlarm(anyRunning, handleAlarm);

  /**
   * Close every prompted lane with its description, then start the break.
   *
   * One Server Action for all of them, not one per lane: this used to be a
   * `for` loop of awaited `segmentLane` calls, i.e. N separate POSTs each
   * paying a fresh admin check, site config read and revalidate. The batch
   * action is also atomic, so `lanes` is either the post-close truth or
   * untouched — there is no half-logged state to reconcile.
   */
  const submitSegments = () => {
    const segments = prompting ?? [];
    startTransition(async () => {
      const result = await segmentLanes(
        segments.map((seg) => ({
          ...seg,
          notes: descriptions[seg.id]?.trim() || null,
          // resume:false — the break happens between chunks, not during one.
          resume: false,
        })),
      );
      if (!apply(result)) return;
      setPrompting(null);
      setDescriptions({});
      setResumeAfterBreak(segments);
      setOnBreak(true);
    });
  };

  /**
   * Break over: reopen every lane that was running before it.
   *
   * Not wrapped in useCallback — the alarm object is a fresh literal each
   * render, so a manual memo can never hold, and the React Compiler handles
   * this better than a dependency list that silently lies.
   */
  const endBreak = (resume: boolean) => {
    setOnBreak(false);
    const toResume = resumeAfterBreak;
    setResumeAfterBreak([]);
    alarm.acknowledge();

    if (!resume || toResume.length === 0) {
      if (!resume) alarm.disarm();
      return;
    }
    startTransition(async () => {
      // One POST for every lane, same as submitSegments. The old loop also
      // swallowed per-lane failures silently; `apply` surfaces them, which
      // matters more now that a failure means nothing resumed at all.
      const result = await startLanes(
        toResume.map((seg) => ({
          track: seg.track,
          categoryId: seg.categoryId,
          title: seg.title,
        })),
      );
      if (!apply(result)) return;
      toast({ title: "back at it", variant: "success" });
    });
  };

  // Lowest free slot rather than max+1: closing lane 1 and adding again should
  // hand back lane 1, not march toward the cap leaving holes behind. Lane
  // numbers are concurrency slots, not identities — nothing about "lane 1"
  // carries meaning across sessions, so reusing one is free.
  const nextFreeLane = (() => {
    for (let t = PRIMARY_TRACK; t <= MAX_TRACK; t++) if (!openLanes.includes(t)) return t;
    return null;
  })();

  const canAddLane = nextFreeLane !== null;
  const addLane = () => {
    if (nextFreeLane === null) return;
    setOpenLanes((l) => [...l, nextFreeLane].sort((a, b) => a - b));
  };

  /**
   * Closes an idle lane. Only ever offered for a lane with nothing running:
   * removing a lane that holds a live entry would leave that row ticking in
   * the database with no card left to stop it from. Lane 0 is permanent —
   * it's the primary lane and the console needs somewhere to start.
   */
  const removeLane = (track: number) => {
    if (track === PRIMARY_TRACK || runningOn(track)) return;
    setOpenLanes((l) => l.filter((t) => t !== track));
    // Drop the draft too, so a lane re-opened on this slot starts clean
    // instead of inheriting what was typed into the last one.
    setDrafts((d) => {
      const next = { ...d };
      delete next[track];
      return next;
    });
  };

  return (
    <>
      <div className="flex flex-col gap-8 pb-32">
        {/* Countdown to the next break. */}
        <section className="flex flex-col items-start gap-6 border-b border-white/10 pb-8 sm:flex-row sm:items-center">
          <TimerRing
            endsAt={alarm.deadline ?? undefined}
            size={132}
            thickness={2}
            direction="drain"
          />
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
              {anyRunning ? "until your break" : "not tracking"}
            </p>
            <p className="mt-2 text-[15px] leading-7 text-white/60">
              {anyRunning
                ? `working in ${alarm.settings.intervalMin}-minute stretches, then a ${alarm.settings.breakMin}-minute break.`
                : "start a lane below. run more than one at a time if you're doing more than one thing."}
            </p>
            {anyRunning && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                icon={Square}
                onClick={handleStopAll}
                disabled={pending}
              >
                end session
              </Button>
            )}
          </div>
        </section>

        {/* Lanes. */}
        <section className="flex flex-col gap-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
            lanes
          </h2>

          {openLanes.map((track) => {
            const running = runningOn(track);
            const d = draftFor(track);
            return (
              <div
                key={track}
                className={cn(
                  "flex flex-col gap-3 border border-white/10 p-4 sm:flex-row sm:items-center",
                  running && "border-white/20 bg-white/[0.02]",
                )}
              >
                <span className="w-16 shrink-0 font-mono text-[11px] uppercase tracking-[0.18em] text-white/30">
                  lane {track}
                </span>

                {running ? (
                  <>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ background: colorOf.get(running.categoryId ?? "") ?? "#fff" }}
                      />
                      <span className="truncate text-sm text-white">
                        {running.title || nameOf.get(running.categoryId ?? "") || "untitled"}
                      </span>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      icon={Square}
                      onClick={() => handleStop(running.id)}
                      disabled={pending}
                    >
                      stop
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="w-full sm:w-48">
                      <Select
                        value={d.categoryId}
                        onChange={(v) => setDraft(track, { categoryId: String(v) })}
                        options={options}
                        placeholder="subject"
                        ariaLabel={`subject for lane ${track}`}
                        size="compact"
                      />
                    </div>
                    <Input
                      value={d.title}
                      onChange={(e) => setDraft(track, { title: e.target.value })}
                      placeholder="what are you working on?"
                      aria-label={`title for lane ${track}`}
                      className="flex-1"
                    />
                    <Button
                      variant="solid"
                      size="sm"
                      icon={Play}
                      onClick={() => handleStart(track)}
                      disabled={pending}
                    >
                      start
                    </Button>
                  </>
                )}

                {/* Idle non-primary lanes can be closed. A running lane shows
                    no close button — stop it first, so the entry it holds is
                    logged rather than stranded. */}
                {!running && track !== PRIMARY_TRACK && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={X}
                    label={`close lane ${track}`}
                    tooltip="close lane"
                    onClick={() => removeLane(track)}
                    disabled={pending}
                    className="self-end text-white/30 hover:text-white sm:self-auto"
                  />
                )}
              </div>
            );
          })}

          {canAddLane && (
            <Button
              variant="dashed"
              size="sm"
              icon={Plus}
              onClick={addLane}
              className="self-start"
            >
              add a parallel lane
            </Button>
          )}
        </section>

        {/* Alarm settings. */}
        <section className="flex flex-col gap-5 border-t border-white/10 pt-8">
          <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
            <Settings2 aria-hidden className="size-3.5" />
            rhythm
          </h2>

          <div className="flex flex-col gap-6 sm:flex-row sm:gap-12">
            <IntervalPicker
              label="work for"
              value={alarm.settings.intervalMin}
              onChange={(m) => alarm.setSettings({ intervalMin: m })}
              presets={[25, 50, 90]}
            />
            <IntervalPicker
              label="then break for"
              value={alarm.settings.breakMin}
              onChange={(m) => alarm.setSettings({ breakMin: m })}
              presets={[5, 10, 20]}
              max={60}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={alarm.settings.sound ? "solid" : "outline"}
              size="sm"
              icon={Volume2}
              onClick={() => {
                const next = !alarm.settings.sound;
                alarm.setSettings({ sound: next });
                if (next) alarm.testChime();
              }}
            >
              {alarm.settings.sound ? "sound on" : "sound off"}
            </Button>

            {alarm.notifyPermission !== "unsupported" && (
              <Button
                variant={
                  alarm.settings.notify && alarm.notifyPermission === "granted"
                    ? "solid"
                    : "outline"
                }
                size="sm"
                icon={Bell}
                onClick={async () => {
                  if (alarm.notifyPermission !== "granted") await alarm.requestNotify();
                  alarm.setSettings({ notify: !alarm.settings.notify });
                }}
              >
                {alarm.notifyPermission === "denied"
                  ? "notifications blocked"
                  : alarm.settings.notify && alarm.notifyPermission === "granted"
                    ? "notifications on"
                    : "notifications off"}
              </Button>
            )}
          </div>
        </section>
      </div>

      {/* "what did you do?" — asked before anything is written. */}
      {prompting && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="segment-title"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4"
        >
          <div className="max-h-[85dvh] w-full max-w-lg overflow-y-auto border border-white/20 bg-[#0a0a0a] p-6">
            <h2
              id="segment-title"
              className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40"
            >
              what did you get done?
            </h2>
            <p className="mt-2 text-[15px] leading-7 text-white/60">
              {alarm.settings.intervalMin} minutes are up. this gets saved onto the
              entry, then you take {alarm.settings.breakMin}.
            </p>

            <div className="mt-6 flex flex-col gap-5">
              {prompting.map((seg) => (
                <div key={seg.id}>
                  <label
                    htmlFor={`desc-${seg.id}`}
                    className="mb-1.5 flex items-center gap-2 text-sm text-white/80"
                  >
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0"
                      style={{ background: colorOf.get(seg.categoryId ?? "") ?? "#fff" }}
                    />
                    {seg.title || nameOf.get(seg.categoryId ?? "") || `lane ${seg.track}`}
                  </label>
                  <Textarea
                    id={`desc-${seg.id}`}
                    rows={2}
                    placeholder="what happened in that stretch?"
                    value={descriptions[seg.id] ?? ""}
                    onChange={(e) =>
                      setDescriptions((v) => ({ ...v, [seg.id]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="solid" onClick={submitSegments} disabled={pending}>
                log it and break
              </Button>
            </div>
          </div>
        </div>
      )}

      <BreakOverlay
        open={onBreak}
        seconds={alarm.settings.breakMin * 60}
        title="break"
        message="stand up. look at something far away."
        onResume={() => endBreak(true)}
        onSkip={() => endBreak(true)}
        onComplete={() => endBreak(true)}
      />

      <LaneBar
        position="fixed"
        lanes={lanes.map((l) => ({
          id: l.id,
          title: l.title || nameOf.get(l.categoryId ?? "") || "untitled",
          subtitle: `lane ${l.track}`,
          startedAt: l.startAt,
          accent: colorOf.get(l.categoryId ?? "") ?? undefined,
        }))}
        actions={
          anyRunning ? (
            <Button variant="outline" size="sm" onClick={handleStopAll} disabled={pending}>
              stop all
            </Button>
          ) : null
        }
      />
    </>
  );
}
