/**
 * Rasterise the icon: src/app/icon.svg -> favicon.ico + apple-icon.png.
 *
 * The SVG that generate.py emits is the single source of truth. Both raster
 * files below are derived, disposable, and wiped before every run — if they
 * ever disagree with the SVG, that is a bug, not a variant. Delete all three
 * outputs and `bun run icons` puts them back.
 *
 * WHY THESE TWO FILES ARE STILL RASTER. They are fallbacks, not the icon.
 * Browsers use src/app/icon.svg, which is vector and stays vector. But the
 * legacy /favicon.ico path is the ICO container format by definition, and
 * Apple touch icons have only ever accepted PNG — neither can be an SVG, and
 * Next cannot code-generate a favicon (an app-icons.md rule), so it has to
 * exist as a file.
 *
 * LIBRARIES, NOT HAND-ROLLED. sharp bundles librsvg, so it rasterises the SVG
 * itself and this script needs no system rsvg-convert on PATH. png-to-ico
 * writes the multi-size container that an earlier pass of this repo built by
 * hand-packing ICONDIR structs. Both are declared devDependencies, so a clean
 * checkout can reproduce the icons.
 *
 *     bun run icons        # regenerate the SVG, then everything downstream
 *     node design/favicon/build.mjs   # rasters only, from the existing SVG
 */
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = resolve(ROOT, "src/app/icon.svg");
const ICO = resolve(ROOT, "src/app/favicon.ico");
const APPLE = resolve(ROOT, "src/app/apple-icon.png");

// 16 is the browser tab, 32 the bookmark bar and most OS surfaces, 48 the
// Windows taskbar. Beyond that, anything asking for a large icon gets the SVG.
const ICO_SIZES = [16, 32, 48];
const APPLE_SIZE = 180;

/**
 * Render at one size. ensureAlpha() matters: librsvg drops the alpha channel
 * when a drawing is fully opaque, and Turbopack's ICO decoder rejects RGB
 * outright — the build fails with "The PNG is not in RGBA format!". Our disc
 * is transparent at the corners so this is usually moot, but the failure is
 * silent until build time, so it is pinned rather than assumed.
 */
async function render(svg, size) {
  return sharp(svg, { density: 384 })
    .resize(size, size)
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function main() {
  const svg = await readFile(SOURCE);

  // Wipe first, so a failure halfway through leaves obviously-missing files
  // rather than a stale icon that silently disagrees with the SVG.
  await Promise.all([rm(ICO, { force: true }), rm(APPLE, { force: true })]);

  const frames = await Promise.all(ICO_SIZES.map((s) => render(svg, s)));
  await writeFile(ICO, await pngToIco(frames));
  await writeFile(APPLE, await render(svg, APPLE_SIZE));

  console.log(`favicon.ico    ${ICO_SIZES.join("+")}`);
  console.log(`apple-icon.png ${APPLE_SIZE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
