"use client";

import { cn } from "@/lib/utils";

/**
 * The palette is re-exported from `@/lib/colors` rather than redefined here.
 *
 * The registry ships its own copy of this list, and that copy was byte-identical
 * to the one already in this repo — which is exactly the problem. `lib/colors.ts`
 * is what `isPaletteColor` reads, and every category write is validated against
 * it server-side. A second list living in a client component means the day
 * either one gains a color, the picker offers a swatch the server rejects with
 * `invalid-color` and the user gets a failure with nothing visibly wrong. One
 * list, validated in one place.
 */
export type { PaletteColor } from "@/lib/colors";
export { CATEGORY_PALETTE, pickNextUnusedColor } from "@/lib/colors";

import { CATEGORY_PALETTE, type PaletteColor } from "@/lib/colors";

export type ColorSwatchProps = {
  /** Hex color rendered as the chip fill. */
  color: string;
  className?: string;
  title?: string;
};

/** A tiny presentational color chip. */
export function ColorSwatch({ color, className, title }: ColorSwatchProps) {
  return (
    <span
      className={cn("inline-block size-3 border border-white/30", className)}
      style={{ backgroundColor: color }}
      title={title}
    />
  );
}

export type ColorSwatchPickerProps = {
  /** Currently selected hex, or null when nothing is chosen. */
  value: string | null;
  onChange: (hex: string) => void;
  /** Palette to choose from. Defaults to CATEGORY_PALETTE. */
  palette?: readonly PaletteColor[];
  className?: string;
  ariaLabel?: string;
};

/** A fixed-palette picker: a row of swatches, one selectable at a time. */
export function ColorSwatchPicker({
  value,
  onChange,
  palette = CATEGORY_PALETTE,
  className,
  ariaLabel,
}: ColorSwatchPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel ?? "color"}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {palette.map((c) => {
        const active = c.hex === value;
        return (
          <button
            key={c.hex}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={c.name}
            title={c.name}
            onClick={() => onChange(c.hex)}
            className={cn(
              "inline-block size-5 border p-0",
              active
                ? "border-white"
                : "border-white/20 hover:border-white/50",
            )}
            style={{ backgroundColor: c.hex }}
          />
        );
      })}
    </div>
  );
}
