#!/usr/bin/env python3
"""Generate the hours icon: an ascii-shaded hourglass on a black disc.

A sibling to the donut on justin06lee.dev and chrome.justin06lee.dev, and to
the cup on coffee.justin06lee.dev — same pipeline, same ramp, same disc. A real
form is raymarched, lit, sampled onto a character grid, and each cell is drawn
as the rect skeleton of the glyph its luminance lands on.

Glyphs are rects rather than <text>, for the reason coffee gives: a favicon is
rendered where font availability isn't guaranteed, and a missing monospace face
would leave an empty disc. Rect geometry always draws.

WHAT THIS ONE DOES DIFFERENTLY

Yaw is gone. The cup needed it to turn its handle into silhouette, but an
hourglass is a solid of revolution — every yaw gives the identical outline, so
the only camera freedom that buys anything is pitch. Looking down ~21 degrees
opens the plates into ellipses, and that ellipse is what makes the mark read as
an object in space rather than a flat bowtie.

Two materials, the way the cup separates ceramic from coffee:

  GLASS is deliberately almost unlit — a low base and a small lambert gain, with
  nearly all of its brightness coming from the rim term. So the bulbs read as a
  bright outline around a dark interior, which is what glass looks like and,
  more usefully, is the one structure that survives being averaged down to a
  tab. A brightly shaded glass wall competed with the sand and the whole mark
  turned into one grey lozenge.

  SAND is the opposite: bright, flat, barely shaded, no rim. It has to read as a
  solid mass sitting in the lower bulb, because that mass is the entire point of
  the site — the hours already poured in. The upper bulb is left empty so there
  is somewhere for them to have come from.

The stream through the waist is one or two cells wide and is gone by 16px. It is
kept because it costs nothing at tab size and makes the mark legible as running
rather than finished at the artboard size, where the icon is actually looked at.

TUNING is for 16px, not for the 136px artboard, exactly as coffee argues: at a
tab's real size a 30x30 grid averages to well under one cell per pixel, so only
the silhouette and the coarse light-to-dark structure survive.

    python3 design/favicon/generate.py > src/app/icon.svg
"""
import math
import sys

N = 30                  # cells across
VIEW = 136.0            # viewBox units
CELL = VIEW / N
DISC = 0.97             # black disc radius, normalised
LEVELS = 11             # 1..11; 0 is empty, mirroring the ramp's leading space
# World units across the disc radius; lower zooms in. Tuned by eye against
# coffee's cup so the two marks carry the same visual weight in a tab. 1.02 left
# the hourglass reading small and timid inside its disc; 0.88 pushed the plates
# into the disc edge and lost the floating-in-a-circle framing the family has.
SCALE = 0.94

# Profile of the solid of revolution: radius grows linearly with height off the
# waist, so the two bulbs are cones sharing an apex.
WAIST = 0.055           # neck radius — the pinch
FLARE = 0.80            # how fast each bulb opens out
BULB_H = 0.52           # half-height of the glass, waist to plate
WALL = 0.045            # glass thickness, so sand sits inside a visible wall

PLATE_R = 0.56          # plates overhang the bulbs slightly
PLATE_H = 0.07          # plate half-thickness
PLATE_Y = BULB_H + PLATE_H

SAND_LEVEL = -0.14      # sand fills the lower bulb up to here
STREAM_R = 0.022        # falling stream, a hair wider than the waist is tight

PITCH = math.radians(21)   # looking down, to open the plates into ellipses
# Off-axis on purpose: a light straight down the view direction leaves a
# surface of revolution almost unshaded, which is what makes these marks read
# flat. Coffee hit the same wall.
LIGHT = (-0.52, 0.46, -0.72)

RIM = 0.58              # how much the silhouette edge is lifted
RIM_FALLOFF = 2.0       # higher confines the lift to a thinner outline

# The ascii ramp these levels stand for. Only used by --preview, but it is the
# alphabet glyph() draws, so it lives next to the level count it indexes.
RAMP = " ,-~:;=!*#$@"


def norm(v):
    m = math.sqrt(sum(c * c for c in v)) or 1.0
    return (v[0] / m, v[1] / m, v[2] / m)


LIGHT = norm(LIGHT)


def sd_capped_cylinder(p, h, r):
    dx = math.hypot(p[0], p[2]) - r
    dy = abs(p[1]) - h
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    return min(max(dx, dy), 0.0) + outside


def sd_flared(p, h, waist, flare, shift=0.0):
    """The hourglass profile: a capped cylinder whose radius opens with |y|.

    Not an exact distance — the flare makes the gradient steeper than 1, so the
    field overestimates and a full-length march would step through the surface.
    trace() compensates with a short step factor rather than by normalising
    here, which keeps this readable as the profile it is.
    """
    r = waist + flare * abs(p[1] - shift)
    dx = math.hypot(p[0], p[2]) - r
    dy = abs(p[1] - shift) - h
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    return min(max(dx, dy), 0.0) + outside


# Surface ids, so the sand can be shaded differently from the glass.
GLASS, SAND = 0, 1


def scene(p):
    """Signed distance to the hourglass, and which material was nearest."""
    glass = sd_flared(p, BULB_H, WAIST, FLARE)
    glass = min(glass, sd_capped_cylinder((p[0], p[1] - PLATE_Y, p[2]),
                                          PLATE_H, PLATE_R))
    glass = min(glass, sd_capped_cylinder((p[0], p[1] + PLATE_Y, p[2]),
                                          PLATE_H, PLATE_R))

    # Sand: the same profile inset by the wall, then cut off at the fill line.
    # Intersecting with a half-space is what gives it a flat top surface.
    sand = sd_flared(p, BULB_H - WALL, max(WAIST - WALL * 0.5, 0.012), FLARE)
    sand = max(sand, p[1] - SAND_LEVEL)

    # The stream, falling from the waist into the pile.
    stream = sd_capped_cylinder(
        (p[0], p[1] - (SAND_LEVEL + 0.16) / 1.0, p[2]),
        0.17, STREAM_R
    )
    sand = min(sand, stream)

    if sand < glass:
        return sand, SAND
    return glass, GLASS


def normal_at(p):
    e = 0.0015
    dx = scene((p[0] + e, p[1], p[2]))[0] - scene((p[0] - e, p[1], p[2]))[0]
    dy = scene((p[0], p[1] + e, p[2]))[0] - scene((p[0], p[1] - e, p[2]))[0]
    dz = scene((p[0], p[1], p[2] + e))[0] - scene((p[0], p[1], p[2] - e))[0]
    return norm((dx, dy, dz))


def rotate(v):
    """Camera space to world space. Pitch only — see the module docstring."""
    x, y, z = v
    cp, sp = math.cos(PITCH), math.sin(PITCH)
    y, z = y * cp - z * sp, y * sp + z * cp
    return (x, y, z)


def trace(u, v):
    """Luminance in 0..1 for a ray through screen point (u, v), 0 for a miss."""
    origin = rotate((u, v, -3.0))
    direction = rotate((0.0, 0.0, 1.0))

    t = 0.0
    for _ in range(120):
        p = (origin[0] + direction[0] * t,
             origin[1] + direction[1] * t,
             origin[2] + direction[2] * t)
        d, material = scene(p)
        if d < 0.002:
            n = normal_at(p)
            lambert = max(0.0, sum(n[i] * LIGHT[i] for i in range(3)))
            # Cells whose normal has turned away from the camera sit on the
            # silhouette. Lifting them draws the outline in bright glyphs, and
            # the outline is the one feature that reads once the texture has
            # averaged itself away at tab size.
            facing = abs(sum(n[i] * direction[i] for i in range(3)))
            edge = (1.0 - min(1.0, facing)) ** RIM_FALLOFF

            if material == SAND:
                # Brighter than the glass and almost unshaded, with no rim: a
                # solid mass rather than a lit surface. It is the top of the
                # ramp, so the lower bulb stays a filled block after the
                # texture averages away — which is the thing worth keeping.
                return min(1.0, 0.74 + 0.24 * lambert)
            # The vessel gets coffee's ceramic curve: a low floor and a gain
            # that reaches the top of the ramp. The first pass tried to be
            # clever and left the glass nearly unlit, on the theory that glass
            # is mostly outline. It is, and the mark went black — at 16px there
            # was no ink left to average. Spending the full ramp is what buys
            # the small sizes; the rim keeps the lit side off a flat slab.
            return min(1.0, 0.10 + 0.90 * lambert + RIM * edge)
        if t > 6.0:
            break
        # 0.55 rather than coffee's 0.85: the flared profile above is not a
        # true distance field and a longer step marches straight through the
        # neck, which shows up as holes punched in the waist.
        t += max(d * 0.55, 0.004)
    return 0.0


def glyph(level, cx, cy):
    """Rects for one cell, shaped to evoke the ascii ramp it stands in for.

    Kept identical to coffee.justin06lee.dev's so the two marks are visibly the
    same alphabet drawn at the same weights.
    """
    s = CELL
    unit = s / 5.0
    px, py = cx - s / 2.0, cy - s / 2.0

    def rect(gx, gy, gw, gh):
        # Emitted as path data rather than a <rect> element: the icon is a few
        # hundred marks, and "M.. h.. v.. h.. z" is less than half the bytes of
        # the equivalent element once they are all concatenated into one path.
        return (f"M{px + gx * unit:.1f} {py + gy * unit:.1f}"
                f"h{gw * unit:.1f}v{gh * unit:.1f}h{-gw * unit:.1f}z")

    if level <= 1:                      # ,
        return [rect(2, 3, 1.1, 1.1)]
    if level <= 3:                      # - ~
        return [rect(1, 2.1, 3, 1)]
    if level <= 5:                      # : ;
        return [rect(2, 0.6, 1.1, 1.3), rect(2, 3.2, 1.1, 1.3)]
    if level <= 7:                      # = !
        return [rect(0.6, 1.1, 3.8, 1), rect(0.6, 3.0, 3.8, 1)]
    if level <= 9:                      # * #
        return [rect(0.5, 1.1, 4, 0.9), rect(0.5, 3.1, 4, 0.9),
                rect(1.4, 0.3, 0.9, 4.4), rect(2.8, 0.3, 0.9, 4.4)]
    return [rect(0.35, 0.35, 4.3, 4.3)]  # $ @


def sample():
    """The level grid: one 0..LEVELS value per cell, None outside the disc."""
    grid = []
    for row in range(N):
        line = []
        for col in range(N):
            cx, cy = (col + 0.5) * CELL, (row + 0.5) * CELL
            u = (cx - VIEW / 2) / (VIEW / 2) * SCALE
            v = -(cy - VIEW / 2) / (VIEW / 2) * SCALE
            if math.hypot(u / SCALE, v / SCALE) > DISC - 0.02:
                line.append(None)
            else:
                line.append(int(round(trace(u, v) * LEVELS)))
        grid.append(line)
    return grid


def preview(grid):
    """Print the grid as the ascii it stands for. Tuning is done by eye, and
    reading the ramp directly is faster than rendering a png to find out that
    the whole mark landed in two adjacent levels."""
    hist = {}
    for line in grid:
        row = ""
        for level in line:
            if level is None:
                row += " "
            else:
                row += RAMP[max(0, min(len(RAMP) - 1, level))]
                hist[level] = hist.get(level, 0) + 1
        sys.stdout.write(row.rstrip() + "\n")
    total = sum(hist.values()) or 1
    sys.stdout.write("\nlevel histogram (inked cells: %d)\n" % total)
    for level in sorted(hist):
        bar = "#" * max(1, round(hist[level] / total * 60))
        sys.stdout.write(f"  {level:>2} {RAMP[level]}  {hist[level]:>4}  {bar}\n")


def main():
    grid = sample()

    if "--preview" in sys.argv:
        preview(grid)
        return

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEW:.0f} {VIEW:.0f}"'
        f' width="{VIEW:.0f}" height="{VIEW:.0f}">',
        "<title>hours</title>",
        # The disc is the whole background; outside it stays transparent, the
        # way the donut icons on the other sites do it.
        f'<circle cx="{VIEW / 2:.0f}" cy="{VIEW / 2:.0f}"'
        f' r="{DISC * VIEW / 2:.2f}" fill="#000000"/>',
    ]

    buckets = {}
    for row in range(N):
        for col in range(N):
            level = grid[row][col]
            if not level or level <= 0:
                continue
            cx, cy = (col + 0.5) * CELL, (row + 0.5) * CELL
            buckets.setdefault(level, []).extend(glyph(level, cx, cy))

    for level in sorted(buckets):
        # The floor is low on purpose: the faintest glyphs have to actually
        # recede, or every cell contributes ink and the disc fills in.
        opacity = 0.13 + 0.87 * (level / LEVELS)
        out.append(
            f'<path fill="#ffffff" fill-opacity="{opacity:.2f}"'
            f' d="{"".join(buckets[level])}"/>'
        )

    out.append("</svg>")
    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
