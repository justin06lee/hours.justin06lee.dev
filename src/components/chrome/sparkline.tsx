import { cn } from "@/lib/utils";

export type SparklineProps = {
  /** The series, oldest first. One value renders a flat line. */
  values: number[];
  /** Intrinsic width in px. Default 80. */
  width?: number;
  /** Intrinsic height in px. Default 24. */
  height?: number;
  /** Line color. Default "currentColor" so it inherits the surrounding text. */
  stroke?: string;
  /** Line thickness in px. Default 1.5. */
  strokeWidth?: number;
  /** Area fill under the line. Omit for a bare line. */
  fill?: string;
  /** Mark every point with a small square. */
  showDots?: boolean;
  /** Mark only the last point — the cheapest way to say "you are here". */
  highlightLast?: boolean;
  /** Scale floor. Defaults to the series minimum. */
  min?: number;
  /** Scale ceiling. Defaults to the series maximum. */
  max?: number;
  /** "linear" is a polyline; "smooth" fits a catmull-rom curve. Default "linear". */
  curve?: "linear" | "smooth";
  /** Accessible name. A value-range summary is generated when omitted. */
  label?: string;
  className?: string;
};

type Point = { x: number; y: number };

function linearPath(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
}

/**
 * Catmull-Rom through the points, converted to cubic beziers. Tension 6 is the
 * standard uniform form — it passes through every sample, which matters more
 * here than smoothness: a sparkline that misses its own data points lies.
 */
function smoothPath(points: Point[]): string {
  if (points.length < 3) return linearPath(points);
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}

/**
 * Tiny inline trend line — pure SVG, no chart library, sized to sit in a line of
 * text (the 80x24 default). Flat series render on the vertical midline instead
 * of collapsing to the floor, so "no change" still reads as a line.
 *
 * The viewBox stretches to whatever box `className` gives it (the stroke stays
 * 1:1 via `non-scaling-stroke`), so sizing it up is free — but dot squares are
 * drawn in viewBox units and will stretch with it. Keep `width`/`height` close
 * to the rendered size when `showDots`/`highlightLast` are on.
 */
export function Sparkline({
  values,
  width = 80,
  height = 24,
  stroke = "currentColor",
  strokeWidth = 1.5,
  fill,
  showDots = false,
  highlightLast = false,
  min,
  max,
  curve = "linear",
  label,
  className,
}: SparklineProps) {
  const dot = Math.max(2, strokeWidth + 0.5);
  // Inset by half the stroke (plus half a dot when dots show) so nothing clips
  // against the viewBox edges.
  const padX = (showDots || highlightLast ? dot : strokeWidth) / 2;
  const padY = padX;
  const innerW = Math.max(0, width - padX * 2);
  const innerH = Math.max(0, height - padY * 2);

  const lo = min ?? values.reduce((m, v) => (v < m ? v : m), values[0] ?? 0);
  const hi = max ?? values.reduce((m, v) => (v > m ? v : m), values[0] ?? 0);
  const span = hi - lo;

  const points: Point[] = values.map((value, i) => ({
    x: padX + (values.length > 1 ? (i / (values.length - 1)) * innerW : innerW / 2),
    y: span > 0 ? padY + innerH - ((value - lo) / span) * innerH : padY + innerH / 2,
  }));

  const d = points.length === 0 ? "" : curve === "smooth" ? smoothPath(points) : linearPath(points);
  const area =
    fill && points.length > 1
      ? `${d} L${points[points.length - 1]!.x} ${height} L${points[0]!.x} ${height} Z`
      : null;

  const last = points[points.length - 1];
  const accessibleName =
    label ??
    (values.length
      ? `trend, ${values.length} points, from ${values[0]} to ${values[values.length - 1]}, low ${lo}, high ${hi}`
      : "trend, no data");

  return (
    <svg
      role="img"
      aria-label={accessibleName}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={cn("inline-block align-middle overflow-visible", className)}
    >
      {area ? <path d={area} fill={fill} stroke="none" /> : null}
      {d ? (
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="butt"
          strokeLinejoin="miter"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {showDots
        ? points.map((p, i) => (
            <rect
              key={i}
              x={p.x - dot / 2}
              y={p.y - dot / 2}
              width={dot}
              height={dot}
              fill={stroke}
            />
          ))
        : null}
      {!showDots && highlightLast && last ? (
        <rect
          x={last.x - dot / 2}
          y={last.y - dot / 2}
          width={dot}
          height={dot}
          fill={stroke}
        />
      ) : null}
    </svg>
  );
}
