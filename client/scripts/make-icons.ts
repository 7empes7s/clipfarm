// Draws clipfarm's app icons from the logo's own shapes: `npm run icons`.
// The mark: two trim handles around a play triangle, on the accent colour. ffmpeg (already needed
// for clips) turns the SVG into the PNG sizes phones ask for; no image editor, no manual step.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const out = join(import.meta.dirname, "..", "public", "icons");
const ACCENT = "#ffb224";
const INK = "#1b1530";

/** The mark in a 512 box. `bleed` fills the whole square (maskable icons are cropped by the phone). */
function icon({ bleed }: { bleed: boolean }): string {
  const tile = bleed ? `<rect width="512" height="512" fill="${ACCENT}"/>` : `<rect width="512" height="512" rx="116" fill="${ACCENT}"/>`;
  // Maskable icons keep the mark inside the middle 80 %.
  const fit = bleed ? ` transform="translate(256 256) scale(0.78) translate(-256 -256)"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${tile}
  <g fill="${INK}"${fit}>
    <rect x="108" y="128" width="48" height="256" rx="24"/>
    <rect x="356" y="128" width="48" height="256" rx="24"/>
    <path d="M218 208v96a14 14 0 0 0 21 12l72-48a14 14 0 0 0 0-24l-72-48a14 14 0 0 0-21 12z"/>
  </g>
</svg>
`;
}

const tmp = await mkdtemp(join(tmpdir(), "clipfarm-icons-"));
try {
  await writeFile(join(out, "icon.svg"), icon({ bleed: false }));
  const plain = join(tmp, "plain.svg");
  const full = join(tmp, "full.svg");
  await writeFile(plain, icon({ bleed: false }));
  await writeFile(full, icon({ bleed: true }));
  const png = (src: string, size: number, name: string) =>
    run("ffmpeg", ["-v", "error", "-y", "-width", String(size), "-height", String(size), "-i", src, "-frames:v", "1", join(out, name)]);
  await png(plain, 192, "icon-192.png");
  await png(plain, 512, "icon-512.png");
  await png(full, 512, "icon-maskable-512.png");
  // iOS puts its own rounded mask on the home-screen icon and shows no transparency.
  await png(full, 180, "apple-touch-icon.png");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
