/**
 * Derive the raster icons from src/app/icon.svg.
 *
 * The SVG is the only icon committed. favicon.ico and apple-icon.png are built
 * from it here and are gitignored, because a checked-in binary beside the
 * drawing that produced it is a copy waiting to go stale — which it already
 * did once in this repo, when generate.py changed and the PNG was not
 * re-exported. A derived file that cannot be committed cannot drift.
 *
 * These two stay raster because they cannot be anything else: /favicon.ico is
 * the ICO container format by definition, and Apple touch icons have only ever
 * accepted PNG. The icon browsers actually load is the SVG, and it stays
 * vector.
 *
 * Wired to predev and prebuild, so the outputs exist whenever the app is run
 * or built, on a fresh clone included. It only needs node and sharp — python
 * is for redrawing the SVG (`bun run icons:draw`), which is a design-time step,
 * not something a deploy should be made to depend on.
 *
 *     bun run icons        # this script alone, from the committed SVG
 *     bun run icons:draw   # redraw the SVG first, then this
 */
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "src/app/icon.svg");
const ICO = resolve(ROOT, "src/app/favicon.ico");
const APPLE = resolve(ROOT, "src/app/apple-icon.png");

// 16 is the browser tab, 32 the bookmark bar and most OS surfaces, 48 the
// Windows taskbar. Anything wanting bigger gets the SVG.
const ICO_SIZES = [16, 32, 48];
const APPLE_SIZE = 180;

// Rasterise the vector at a high density and downsample, rather than letting
// librsvg draw straight to 16px — the ascii cells are ~4.5 units wide in a 136
// unit viewBox, and drawing them directly at tab size drops cells entirely
// instead of averaging them into grey.
const DENSITY = 384;

async function main() {
  const svg = await readFile(SOURCE);

  // Wipe first: a run that fails halfway should leave obviously-missing files,
  // not a stale icon that quietly disagrees with the SVG.
  await Promise.all([rm(ICO, { force: true }), rm(APPLE, { force: true })]);

  // The tab icon keeps its alpha. The mark is a black disc on transparency, so
  // the corners have to stay clear for it to read as a disc rather than a
  // square on whatever colour the browser paints behind a tab.
  const frames = await Promise.all(
    ICO_SIZES.map((size) =>
      sharp(svg, { density: DENSITY })
        .resize(size, size)
        .ensureAlpha()
        .png()
        .toBuffer(),
    ),
  );
  await writeFile(ICO, await pngToIco(frames));

  // The Apple icon is the opposite: flattened onto black with alpha dropped.
  // iOS composites a touch icon against a background it does not tell you
  // about and handles partial transparency inconsistently, so leaving an alpha
  // channel means the corners render as whatever that build of iOS decides.
  // Black is also what is already behind the disc, so flattening changes
  // nothing visible and removes the question. Dropping the channel is most of
  // why this file is a third of the size it used to be.
  await writeFile(
    APPLE,
    await sharp(svg, { density: DENSITY })
      .resize(APPLE_SIZE, APPLE_SIZE)
      .flatten({ background: "#000000" })
      .removeAlpha()
      .png()
      .toBuffer(),
  );

  console.log(`favicon.ico    ${ICO_SIZES.join("+")}`);
  console.log(`apple-icon.png ${APPLE_SIZE}, opaque`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
