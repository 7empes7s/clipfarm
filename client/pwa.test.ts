import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// What a browser needs before it offers "Install": a manifest with a name, a start page, a
// standalone display and 192 and 512 px icons, served with a service worker that answers fetches.
const pub = join(import.meta.dirname, "public");
const manifest = JSON.parse(readFileSync(join(pub, "manifest.webmanifest"), "utf8")) as {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};
const html = readFileSync(join(import.meta.dirname, "index.html"), "utf8");
const css = readFileSync(join(import.meta.dirname, "src", "styles.css"), "utf8");

describe("installable app", () => {
  it("has a manifest a browser can install from", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url.startsWith("/")).toBe(true);
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) expect(existsSync(join(pub, icon.src)), icon.src).toBe(true);
  });

  it("has the logo drawn in code as its icon, with PNGs for phones", () => {
    const svg = manifest.icons.find((i) => i.type === "image/svg+xml");
    expect(svg?.sizes).toBe("any");
    expect(readFileSync(join(pub, svg!.src), "utf8")).toContain("<svg");
    expect(html).toContain('rel="icon" href="/icons/icon.svg"');
  });

  it("has a service worker that answers fetches", () => {
    const sw = readFileSync(join(pub, "sw.js"), "utf8");
    expect(sw).toContain('addEventListener("fetch"');
    expect(html).toContain('rel="manifest"');
  });

  it("splashes in the theme's own colours, in light and dark", () => {
    const token = (block: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(block)?.[1];
    const light = css.slice(0, css.indexOf("prefers-color-scheme: dark"));
    const dark = css.slice(css.indexOf("prefers-color-scheme: dark"));
    // The installed app opens on the dark splash; the browser bar follows the theme.
    expect(manifest.background_color).toBe(token(dark, "paper"));
    expect(manifest.theme_color).toBe(token(dark, "paper"));
    expect(html).toContain(`name="theme-color" media="(prefers-color-scheme: light)" content="${token(light, "paper")}"`);
    expect(html).toContain(`name="theme-color" media="(prefers-color-scheme: dark)" content="${token(dark, "paper")}"`);
    expect(html).toContain('class="splash"');
  });
});
