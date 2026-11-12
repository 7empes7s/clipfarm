import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sectionFor, YtDlpSectionDownloader, ytDlpSectionArgs } from "./section.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-section-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sectionFor", () => {
  it("pads the pick by 3 s each side and stays inside the VOD", () => {
    expect(sectionFor(100, 130, 3600)).toEqual({ startSec: 97, endSec: 133 });
    expect(sectionFor(1, 30, 3600)).toEqual({ startSec: 0, endSec: 33 });
    expect(sectionFor(3570, 3599, 3600)).toEqual({ startSec: 3567, endSec: 3600 });
    expect(sectionFor(10.25, 40.25, null)).toEqual({ startSec: 7.2, endSec: 43.3 });
  });
});

describe("ytDlpSectionArgs", () => {
  it("downloads only the section at up to 1080p30, and never treats the link as an option", () => {
    const args = ytDlpSectionArgs("https://www.twitch.tv/videos/1", { startSec: 97, endSec: 133 }, "/tmp/job");
    expect(args.slice(args.indexOf("--download-sections"), args.indexOf("--download-sections") + 2)).toEqual([
      "--download-sections",
      "*97-133",
    ]);
    expect(args[1]).toContain("height<=1080");
    expect(args[1]).toContain("fps<=30");
    expect(args.slice(-2)).toEqual(["--", "https://www.twitch.tv/videos/1"]);
  });
});

describe("YtDlpSectionDownloader", () => {
  it("runs the binary with the section args and returns the saved file", async () => {
    // A fake yt-dlp: records its args and writes a file where the real one would. No network.
    const bin = join(dir, "fake-yt-dlp");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const tpl = args[args.indexOf("-o") + 1];
fs.writeFileSync(path.join(path.dirname(tpl), "args.json"), JSON.stringify(args));
fs.writeFileSync(tpl.replace("%(ext)s", "mp4"), "video");
`,
    );
    await chmod(bin, 0o755);
    const section = { startSec: 7, endSec: 40 };
    const file = await new YtDlpSectionDownloader(bin).downloadSection("https://kick.com/video/1", section, dir);
    expect(file).toBe(join(dir, "section.mp4"));
    expect(JSON.parse(await readFile(join(dir, "args.json"), "utf8"))).toEqual(
      ytDlpSectionArgs("https://kick.com/video/1", section, dir),
    );
  });
});
