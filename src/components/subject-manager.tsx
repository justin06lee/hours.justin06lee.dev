"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/chrome/button";
import { Input } from "@/components/chrome/input";
import { Field } from "@/components/chrome/field";
import { Badge } from "@/components/chrome/badge";
import { Callout } from "@/components/chrome/callout";
import { EmptyState } from "@/components/chrome/empty-state";
import { Switch } from "@/components/chrome/switch";
import { ColorSwatchPicker } from "@/components/chrome/color-swatch";
import { DialogProvider, useDialog } from "@/components/chrome/dialog";
import { ToastProvider, useToast } from "@/components/chrome/toast";
import { ModalPanel } from "@/components/modal-panel";
import { createSubject, deleteSubject, updateSubject } from "@/app/actions";
import type { CalendarCategory } from "@/lib/calendar-categories";
import { CATEGORY_PALETTE, pickNextUnusedColor } from "@/lib/colors";
import { formatHours } from "@/lib/hours-math";

/** What a subject row needs beyond the category itself. */
export type SubjectStat = {
  /** Union ms logged against it. */
  ms: number;
  entries: number;
};

export type SubjectManagerProps = {
  categories: CalendarCategory[];
  /** Keyed by category id. Missing means nothing has ever been logged to it. */
  stats: Record<string, SubjectStat>;
};

export function SubjectManager(props: SubjectManagerProps) {
  return (
    <ToastProvider position="bottom-right" anchor="viewport">
      <DialogProvider>
        <Manager {...props} />
      </DialogProvider>
    </ToastProvider>
  );
}

type Draft = { name: string; color: string };

function Manager({ categories, stats }: SubjectManagerProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { confirm } = useDialog();
  const [pending, startTransition] = useTransition();

  // `null` means the dialog is closed; a category means edit; "new" means create.
  const [editing, setEditing] = useState<CalendarCategory | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", color: CATEGORY_PALETTE[0].hex });
  const [formError, setFormError] = useState<string | null>(null);
  const titleId = useId();

  const live = categories.filter((c) => !c.archived);
  const archived = categories.filter((c) => c.archived);

  const onActionFailed = () => {
    toast({
      title: "session expired",
      description: "sign in again to keep editing.",
      variant: "danger",
    });
    router.refresh();
  };

  const openCreate = () => {
    setFormError(null);
    setEditing("new");
    setDraft({
      name: "",
      // Least-used palette colour, so a new subject is visually distinct from
      // its neighbours without anyone having to think about it.
      color: pickNextUnusedColor(categories.map((c) => c.color)),
    });
  };

  const openEdit = (category: CalendarCategory) => {
    setFormError(null);
    setEditing(category);
    setDraft({ name: category.name, color: category.color });
  };

  const close = () => {
    setEditing(null);
    setFormError(null);
  };

  const submit = () => {
    if (editing === null) return;
    const name = draft.name.trim();
    if (name.length === 0) {
      setFormError("give it a name.");
      return;
    }

    startTransition(async () => {
      try {
        const result =
          editing === "new"
            ? await createSubject({ name, color: draft.color })
            : await updateSubject({
                id: editing.id,
                // The seeded Sleep row's name is locked by the library. Sending
                // it unchanged would still be refused as `system-name-locked`,
                // so a rename that isn't a rename is simply not sent.
                ...(editing.isSystem && name === editing.name ? {} : { name }),
                color: draft.color,
              });
        if (!result.ok) {
          setFormError(result.error);
          return;
        }
        close();
        toast({ title: editing === "new" ? "subject added" : "saved", variant: "success" });
        router.refresh();
      } catch {
        onActionFailed();
      }
    });
  };

  const setArchived = (category: CalendarCategory, archivedNext: boolean) => {
    startTransition(async () => {
      try {
        const result = await updateSubject({ id: category.id, archived: archivedNext });
        if (!result.ok) {
          toast({ title: result.error, variant: "danger" });
          return;
        }
        toast({
          title: archivedNext ? "archived" : "back in the list",
          variant: "success",
        });
        router.refresh();
      } catch {
        onActionFailed();
      }
    });
  };

  const remove = async (category: CalendarCategory) => {
    const stat = stats[category.id];
    const logged = stat?.entries ?? 0;

    const ok = await confirm({
      title: `delete ${category.name.toLowerCase()}?`,
      message:
        logged > 0
          ? `${logged} ${logged === 1 ? "entry is" : "entries are"} filed under it, so this will be refused — archive it instead to keep the hours and stop offering it.`
          : "nothing is filed under it, so no hours are affected.",
      confirmText: "delete",
      danger: true,
    });
    if (!ok) return;

    startTransition(async () => {
      try {
        const result = await deleteSubject({ id: category.id });
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

  const row = (category: CalendarCategory) => {
    const stat = stats[category.id];
    return (
      <li
        key={category.id}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/10 py-3"
      >
        <span
          aria-hidden
          className="size-2.5 shrink-0"
          style={{ background: category.color }}
        />
        <span className="min-w-0 flex-1 truncate text-sm text-white/80">
          {category.name.toLowerCase()}
        </span>

        {category.isSystem && (
          <Badge className="gap-1">
            <Lock aria-hidden className="size-3" />
            built in
          </Badge>
        )}

        <span className="shrink-0 tabular-nums text-xs text-white/40">
          {stat ? `${formatHours(stat.ms)} · ${stat.entries}` : "nothing logged"}
        </span>

        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            icon={Pencil}
            label={`edit ${category.name}`}
            tooltip="edit"
            onClick={() => openEdit(category)}
            disabled={pending}
            className="text-white/30 hover:text-white"
          />
          {/* Deleting is only offered where it can actually succeed. The
              library refuses a delete once anything points at the subject, and
              a button that is always refused is worse than no button. */}
          {!category.isSystem && (stat?.entries ?? 0) === 0 && (
            <Button
              variant="ghost"
              size="sm"
              icon={Trash2}
              label={`delete ${category.name}`}
              tooltip="delete"
              onClick={() => void remove(category)}
              disabled={pending}
              className="text-white/30 hover:text-white"
            />
          )}
        </span>

        <span className="w-full sm:w-auto">
          <Switch
            checked={!category.archived}
            onChange={(next) => setArchived(category, !next)}
            disabled={pending}
            size="sm"
            ariaLabel={`offer ${category.name} when starting a lane`}
          />
        </span>
      </li>
    );
  };

  return (
    <>
      {categories.length === 0 ? (
        <EmptyState
          title="no subjects yet"
          description="subjects are the buckets hours get filed under. add the first one."
          action={
            <Button variant="solid" icon={Plus} onClick={openCreate}>
              add a subject
            </Button>
          }
        />
      ) : (
        <>
          <section>
            <div className="mb-2 flex items-baseline justify-between gap-4">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
                offered when starting a lane
              </h2>
              <span className="text-right text-xs text-white/30">hours · entries</span>
            </div>
            {live.length > 0 ? (
              <ul className="flex flex-col">{live.map(row)}</ul>
            ) : (
              <p className="border-t border-white/10 py-3 text-sm text-white/40">
                everything is archived. flip one back on to use it.
              </p>
            )}
          </section>

          {archived.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40">
                archived
              </h2>
              <p className="mb-2 text-xs text-white/30">
                their hours still count — they just aren&apos;t offered any more.
              </p>
              <ul className="flex flex-col">{archived.map(row)}</ul>
            </section>
          )}

          <Button
            variant="dashed"
            size="sm"
            icon={Plus}
            onClick={openCreate}
            disabled={pending}
            className="mt-8"
          >
            add a subject
          </Button>
        </>
      )}

      <ModalPanel open={editing !== null} onClose={close} labelledBy={titleId} className="max-w-md">
        <h2
          id={titleId}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/40"
        >
          {editing === "new" ? "new subject" : "edit subject"}
        </h2>

        <div className="mt-6 flex flex-col gap-5">
          <Field
            label="name"
            hint={
              editing !== null && editing !== "new" && editing.isSystem
                ? "sleep is built in — its name is fixed, but the colour isn't"
                : undefined
            }
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                className="w-full"
                value={draft.name}
                disabled={editing !== null && editing !== "new" && editing.isSystem}
                onChange={(ev) => setDraft({ ...draft, name: ev.target.value })}
                placeholder="studying, building, training…"
              />
            )}
          </Field>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-white/70">colour</span>
            <ColorSwatchPicker
              value={draft.color}
              onChange={(hex) => setDraft({ ...draft, color: hex })}
              palette={CATEGORY_PALETTE}
              ariaLabel="subject colour"
            />
          </div>

          {formError && (
            <Callout variant="danger" title="couldn't save">
              {formError}
            </Callout>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            cancel
          </Button>
          <Button variant="solid" icon={Check} onClick={submit} disabled={pending}>
            {editing === "new" ? "add" : "save"}
          </Button>
        </div>
      </ModalPanel>
    </>
  );
}
