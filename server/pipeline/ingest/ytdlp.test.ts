import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInfoJson, YtDlpDownloader, ytDlpAudioArgs } from "./ytdlp.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-ytdlp-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ytDlpAudioArgs", () => {
  it("downloads audio only, with an info JSON, and never treats the link as an option", () => {
    const args = ytDlpAudioArgs("https://www.twitch.tv/videos/123", "/tmp/job");
    expect(args.slice(0, 2)).toEqual(["-f", "bestaudio/best"]);
    expect(args).toContain("--write-info-json");
    expect(args).toContain("--no-playlist");
    expect(args.slice(-2)).toEqual(["--", "https://www.twitch.tv/videos/123"]);
  });
});

describe("parseInfoJson", () => {
  it("reads title, duration and chapters", () => {
    expect(
      parseInfoJson({
        title: "GTA VI day one",
        duration: 3600,
        chapters: [{ title: "Intro", start_time: 0, end_time: 120 }, { title: "bad" }],
      }),
    ).toEqual({ title: "GTA VI day one", durationSec: 3600, chapters: [{ title: "Intro", startSec: 0, endSec: 120 }] });
    expect(parseInfoJson({ chapters: null })).toEqual({ title: null, durationSec: null, chapters: [] });
  });
});

describe("YtDlpDownloader", () => {
  it("runs the binary with the audio args and returns the saved file and metadata", async () => {
    // A fake yt-dlp: records its args and writes what the real one would. No network.
    const bin = join(dir, "fake-yt-dlp");
    const out = join(dir, "out");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const tpl = args[args.indexOf("-o") + 1];
fs.writeFileSync(path.join(path.dirname(tpl), "args.json"), JSON.stringify(args));
fs.writeFileSync(tpl.replace("%(ext)s", "webm"), "audio");
fs.writeFileSync(tpl.replace("%(ext)s", "info.json"), JSON.stringify({ title: "VOD", duration: 42, chapters: [] }));
`,
    );
    await chmod(bin, 0o755);
    const { mkdir, readFile } = await import("node:fs/promises");
    await mkdir(out);
    const result = await new YtDlpDownloader(bin).downloadAudio("https://kick.com/video/1", out);
    expect(result.file).toBe(join(out, "source.webm"));
    expect(result.meta).toEqual({ title: "VOD", durationSec: 42, chapters: [] });
    expect(JSON.parse(await readFile(join(out, "args.json"), "utf8"))).toEqual(
      ytDlpAudioArgs("https://kick.com/video/1", out),
    );
  });

  it("says plainly when yt-dlp is missing", async () => {
    await expect(new YtDlpDownloader(join(dir, "nope")).downloadAudio("https://x.test/v", dir)).rejects.toThrow(
      "is not installed on this server",
    );
  });
});
