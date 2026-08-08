"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/chrome/button";
import { Input } from "@/components/chrome/input";
import { Textarea } from "@/components/chrome/textarea";
import Select from "@/components/chrome/select";
import { Field } from "@/components/chrome/field";
import { Callout } from "@/components/chrome/callout";
import { EmptyState } from "@/components/chrome/empty-state";
import { Pagination } from "@/components/chrome/pagination";
import { DialogProvider, useDialog } from "@/components/chrome/dialog";
import { ToastProvider, useToast } from "@/components/chrome/toast";
import { ModalPanel } from "@/components/modal-panel";
import { deleteEntry, updateEntry } from "@/app/actions";
import type { JournalEntry } from "@/lib/hours";
import type { CalendarCategory } from "@/lib/calendar-categories";
import { formatElapsed } from "@/lib/hours-math";
import {
  epochToDateInTz,
  epochToHHMMInTz,
  epochToLocalInput,
  localInputToEpoch,
} from "@/lib/calendar-dates";
import { cn } from "@/lib/utils";

export type JournalListProps = {
  entries: JournalEntry[];
  /**
   * Every category, from `listCategories` — **not** `overview.subjects`.
   *
   * The subject list is built from the entries that exist, so a category
   * nothing has been logged against yet is absent from it. Driving the editor's
   * dropdown off that made a freshly created subject unselectable: it existed,
   * it was offered when starting a lane, and it was the one thing you could not
   * move an old entry to.
   */
  categories: CalendarCategory[];
  timezone: string;
  page: number;
  pageCount: number;
  /** Total matching entries, so a bounded list can say it is bounded. */
  total: number;
  /** True when the list is filtered to entries carrying a reflection. */
  notedOnly: boolean;
};

export function JournalList(props: JournalListProps) {
  return (
    <ToastProvider position="bottom-right" anchor="viewport">
      <DialogProvider>
        <Journal {...props} />
      </DialogProvider>
    </ToastProvider>
  );
}

/** The form's working copy of an entry, as strings the inputs can hold. */
type Draft = {
  categoryId: string;
  title: string;
  /** `YYYY-MM-DDTHH:MM` in site time. */
  startLocal: string;
  /** Same, or "" for an entry that is still running. */
  endLocal: string;
  notes: string;
};

function Journal({
  entries,
  categories,
  timezone,
  page,
  pageCount,
  total,
  notedOnly,
}: JournalListProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [pending, startTransition] = useTransition();

  const [editing, setEditing] = useState<JournalEntry | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const titleId = useId();

  const byId = new Map(categories.map((c) => [c.id, c]));

  /**
   * An entry's subject colour, and its name or `null`.
   *
   * Null covers two cases that render identically and should: a genuinely
   * uncategorized entry, and one whose `categoryId` points at a category that
   * no longer exists. The second is reachable — the FK is declared
   * `ON DELETE SET NULL` but libsql does not enable `PRAGMA foreign_keys`, so a
   * row deleted from the sibling site leaves the reference dangling rather than
   * blanking it.
   *
   * Returning null rather than the string "uncategorized" is what keeps the
   * `title || name || "untitled"` chain working — a non-null fallback here
   * makes the "untitled" branch dead and prints "· uncategorized" after every
   * entry that has a title but no subject. The public entry list resolves these
   * the same way, and the two lists showing the same row differently would be
   * worse than either choice.
   */
  const UNCATEGORIZED = "#7a8085";
  const colorFor = (id: string | null) => (id ? byId.get(id)?.color ?? UNCATEGORIZED : UNCATEGORIZED);
  const nameFor = (id: string | null): string | null => (id ? byId.get(id)?.name ?? null : null);

  /**
   * Live categories, plus whichever one this entry is already filed under even
   * if it has been archived. Without that second half, opening an entry on an
   * archived subject would show an empty select, and saving would quietly move
   * the entry to "no subject" — losing the filing to a dropdown that simply
   * declined to mention it.
   */
  const optionsFor = (currentId: string | null) => [
    { value: "", label: "no subject" },
    ...categories
      .filter((c) => !c.archived || c.id === currentId)
      .map((c) => ({
        value: c.id,
        label: c.archived ? `${c.name.toLowerCase()} (archived)` : c.name.toLowerCase(),
        prefix: <span aria-hidden className="size-2 shrink-0" style={{ background: c.color }} />,
      })),
  ];

  const openEditor = (entry: JournalEntry) => {
    setFormError(null);
    setEditing(entry);
    setDraft({
      categoryId: entry.categoryId ?? "",
      title: entry.title ?? "",
      startLocal: epochToLocalInput(entry.startAt, timezone),
      // A running entry has no end to show. Leaving the box empty rather than
      // pre-filling "now" is the honest default: a value here means "stop it
      // then", and nobody opening this dialog has said that yet.
      endLocal: entry.running ? "" : epochToLocalInput(entry.endAt, timezone),
      notes: entry.notes ?? "",
    });
  };

  const closeEditor = () => {
    setEditing(null);
    setDraft(null);
    setFormError(null);
  };

  /**
   * The failure a result can't carry. Every action re-checks admin and that
   * check *throws* rather than returning `{ok:false}`, so an expired session
   * rejects the promise. React hands a rejection inside a transition to
   * `reportGlobalError` and settles the transition quietly — no toast, and a
   * button that will never work again. `refresh()` re-runs the page's own admin
   * gate, which redirects to /login.
   */
  const onActionFailed = () => {
    toast({
      title: "session expired",
      description: "sign in again to keep editing.",
      variant: "danger",
    });
    router.refresh();
  };

  const save = () => {
    if (!editing || !draft) return;

    // Parse in site time, not the browser's. `localInputToEpoch` returns NaN
    // for anything that isn't exactly `YYYY-MM-DDTHH:MM`, so both boxes are
    // checked here — before a NaN can reach a column every total reads.
    const startAt = localInputToEpoch(draft.startLocal, timezone);
    if (!Number.isFinite(startAt)) {
      setFormError("that start time isn't a real date and time.");
      return;
    }

    let endAt: number | undefined;
    if (draft.endLocal !== "") {
      const parsed = localInputToEpoch(draft.endLocal, timezone);
      if (!Number.isFinite(parsed)) {
        setFormError("that end time isn't a real date and time.");
        return;
      }
      endAt = parsed;
    } else if (!editing.running) {
      // Clearing the end of a finished entry would mean reopening it. That is
      // the one edit this surface refuses to make — see EntryPatchInput.
      setFormError("an entry that has finished needs an end time.");
      return;
    }

    if (endAt !== undefined && endAt <= startAt) {
      setFormError("the end has to come after the start.");
      return;
    }

    setFormError(null);
    startTransition(async () => {
      try {
        const result = await updateEntry({
          id: editing.id,
          categoryId: draft.categoryId || null,
          title: draft.title,
          notes: draft.notes,
          startAt,
          ...(endAt !== undefined ? { endAt } : {}),
        });
        if (!result.ok) {
          // Kept in the dialog rather than fired as a toast: the message is
          // about the values still on screen, and the user is about to change
          // one of them.
          setFormError(result.error);
          return;
        }
        closeEditor();
        toast({ title: "saved", variant: "success" });
        router.refresh();
      } catch {
        onActionFailed();
      }
    });
  };

  const remove = async (entry: JournalEntry) => {
    const label = entry.title || nameFor(entry.categoryId) || "this entry";
    const ok = await confirm({
      title: `delete ${label.toLowerCase()}?`,
      message:
        "the time it holds comes off every total on the site. this can't be undone.",
      confirmText: "delete",
      danger: true,
    });
    if (!ok) return;

    startTransition(async () => {
      try {
        const result = await deleteEntry({ id: entry.id });
        if (!result.ok) {
          toast({ title: result.error, variant: "danger" });
          return;
        }
        toast({ title: "deleted", variant: "success" });
        router.refresh();
      } catch {
        onActionFailed();
      }
    });
  };

  const goToPage = (next: number) => {
    const params = new URLSearchParams();
    if (next > 1) params.set("page", String(next));
    if (notedOnly) params.set("notes", "1");
    const query = params.toString();
    router.push(query ? `/track/journal?${query}` : "/track/journal");
  };

  if (entries.length === 0) {
    return notedOnly ? (
      <EmptyState
        title="nothing written down yet"
        description="the break prompt asks what you got done. answers land here."
        action={
          <Button variant="outline" href="/track/journal" linkComponent={Link}>
            show every entry
          </Button>
        }
      />
    ) : (
      <EmptyState
        title="nothing logged yet"
        description="start a lane and the entries will show up here."
        action={
          <Button variant="outline" href="/track" linkComponent={Link}>
            open the console
          </Button>
        }
      />
    );
  }

  // Group by the day the entry started, in site time — same rule as the public
  // entry list, so the two read as the same log.
  const groups: { date: string; rows: JournalEntry[] }[] = [];
  for (const e of entries) {
    const date = epochToDateInTz(e.startAt, timezone);
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.rows.push(e);
    else groups.push({ date, rows: [e] });
  }

  return (
    <>
      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <div key={g.date}>
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/30">
              {g.date}
            </p>
            <ul className="flex flex-col">
              {g.rows.map((e) => (
                <li key={e.id} className="border-t border-white/10 py-3">
                  <div className="flex items-baseline gap-3 text-sm">
                    <span
                      aria-hidden
                      className="mt-1 size-1.5 shrink-0"
                      style={{ background: colorFor(e.categoryId) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-white/80">
                      {e.title || nameFor(e.categoryId) || "untitled"}
                      {e.title && nameFor(e.categoryId) && (
                        <span className="text-white/30">
                          {" "}
                          · {nameFor(e.categoryId)?.toLowerCase()}
                        </span>
                      )}
                    </span>
                    {e.track > 0 && (
                      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-white/30">
                        lane {e.track}
                      </span>
                    )}
                    <span className="shrink-0 tabular-nums text-white/40">
                      {epochToHHMMInTz(e.startAt, timezone)}
                    </span>
                    <span
                      className={cn(
                        "w-16 shrink-0 text-right tabular-nums",
                        e.running ? "text-white" : "text-white/60",
                      )}
                    >
                      {e.running ? "running" : formatElapsed(e.endAt - e.startAt)}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Pencil}
                        label={`edit ${e.title || "entry"}`}
                        tooltip="edit"
                        onClick={() => openEditor(e)}
                        disabled={pending}
                        className="text-white/30 hover:text-white"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        label={`delete ${e.title || "entry"}`}
                        tooltip="delete"
                        onClick={() => void remove(e)}
                        disabled={pending}
                        className="text-white/30 hover:text-white"
                      />
                    </span>
                  </div>

                  {e.notes && (
                    <p className="mt-2 whitespace-pre-line border-l border-white/10 pl-3 text-[13px] leading-6 text-white/50 sm:ml-[18px]">
                      {e.notes}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-white/30">
        {entries.length} of {total} {total === 1 ? "entry" : "entries"}
      </p>

      {/* Returns null at one page or fewer, so this is safe to render flat. */}
      <Pagination
        page={page}
        pageCount={pageCount}
        onChange={goToPage}
        className="mt-4"
      />

      <ModalPanel open={editing !== null} onClose={closeEditor} labelledBy={titleId}>
        {editing && draft && (
          <>
            <h2
              id={titleId}
              className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40"
            >
              edit entry
            </h2>

            <div className="mt-6 flex flex-col gap-5">
              {/* Deliberately not wrapped in `Field`. Field's whole value is
                  the render prop that hands a control its id and aria wiring,
                  and Select is a button-based combobox that accepts neither —
                  a Field around it would render a <label htmlFor> pointing at
                  an element that does not exist. `ariaLabel` names it instead. */}
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-white/70">subject</span>
                <Select
                  value={draft.categoryId}
                  onChange={(v) => setDraft({ ...draft, categoryId: String(v) })}
                  options={optionsFor(editing.categoryId)}
                  placeholder="subject"
                  ariaLabel="subject"
                />
              </div>

              <Field label="title">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    className="w-full"
                    value={draft.title}
                    onChange={(ev) => setDraft({ ...draft, title: ev.target.value })}
                    placeholder="what were you working on?"
                  />
                )}
              </Field>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="started" hint={`site time · ${timezone}`}>
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      type="datetime-local"
                      className="w-full"
                      value={draft.startLocal}
                      onChange={(ev) => setDraft({ ...draft, startLocal: ev.target.value })}
                    />
                  )}
                </Field>

                <Field
                  label="ended"
                  hint={editing.running ? "still running — a time here stops it" : undefined}
                >
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      type="datetime-local"
                      className="w-full"
                      value={draft.endLocal}
                      onChange={(ev) => setDraft({ ...draft, endLocal: ev.target.value })}
                    />
                  )}
                </Field>
              </div>

              <Field label="notes" hint="what you got done in this stretch.">
                {(fieldProps) => (
                  <Textarea
                    {...fieldProps}
                    rows={4}
                    value={draft.notes}
                    onChange={(ev) => setDraft({ ...draft, notes: ev.target.value })}
                    placeholder="nothing written down for this one."
                  />
                )}
              </Field>

              {formError && (
                <Callout variant="danger" title="couldn't save">
                  {formError}
                </Callout>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              {/* Not disabled while pending: the reason to reach for it is a
                  save that already failed, and a dialog with no way out is a
                  defect rather than a safeguard. */}
              <Button variant="ghost" onClick={closeEditor}>
                cancel
              </Button>
              <Button variant="solid" onClick={save} disabled={pending}>
                save
              </Button>
            </div>
          </>
        )}
      </ModalPanel>
    </>
  );
}
