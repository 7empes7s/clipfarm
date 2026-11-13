import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../tools/exec.js";
import { probeVideo } from "../tools/ffmpeg.js";
import { ffmpegHlsArgs, kickPlaybackUrl, type LiveCapturer, PlatformLiveCapturer, recordHls, YtDlpLiveCapturer, ytDlpLiveArgs } from "./capturer.js";

let dir: string;
let server: Server | null = null;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-capturer-test-"));
});
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)));
  server = null;
  await rm(dir, { recursive: true, force: true });
});

describe("ytDlpLiveArgs", () => {
  it("records from now for a set time through ffmpeg, and never treats the link as an option", () => {
    const args = ytDlpLiveArgs("https://www.twitch.tv/kaicenat", 660, "/tmp/live", "segment-3");
    expect(args).toContain("--no-live-from-start");
    expect(args).not.toContain("--live-from-start");
    expect(args.slice(args.indexOf("--downloader"), args.indexOf("--downloader") + 4)).toEqual(["--downloader", "ffmpeg", "--downloader-args", "ffmpeg:-t 660"]);
    expect(args[args.indexOf("-o") + 1]).toBe("/tmp/live/segment-3.%(ext)s");
    expect(args.slice(-2)).toEqual(["--", "https://www.twitch.tv/kaicenat"]);
  });
});

describe("YtDlpLiveCapturer", () => {
  it("runs the binary with the live args and returns the saved file", async () => {
    // A stand-in yt-dlp: records its args and writes what the real one would. No network.
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
    const out = join(dir, "out");
    await mkdir(out);
    const target = { platform: "twitch" as const, handle: "kaicenat", url: "https://www.twitch.tv/kaicenat" };
    const file = await new YtDlpLiveCapturer(bin).record(target, { durationSec: 660, dir: out, name: "segment-0" });
    expect(file).toBe(join(out, "segment-0.mp4"));
    expect(JSON.parse(await readFile(join(out, "args.json"), "utf8"))).toEqual(ytDlpLiveArgs(target.url, 660, out, "segment-0"));
  });

  it("says plainly when yt-dlp is missing or fails", async () => {
    const target = { platform: "youtube" as const, handle: "x", url: "https://www.youtube.com/@x" };
    await expect(new YtDlpLiveCapturer(join(dir, "nope")).record(target, { durationSec: 5, dir, name: "s" })).rejects.toThrow("is not installed on this server");
    const bin = join(dir, "failing");
    await writeFile(bin, '#!/bin/sh\necho "ERROR: the channel is offline" >&2\nexit 1\n');
    await chmod(bin, 0o755);
    await expect(new YtDlpLiveCapturer(bin).record(target, { durationSec: 5, dir, name: "s" })).rejects.toThrow("the channel is offline");
  });

  it("stops the recorder when asked", async () => {
    const bin = join(dir, "slow");
    await writeFile(bin, "#!/bin/sh\nsleep 30\n");
    await chmod(bin, 0o755);
    const stop = new AbortController();
    const recording = new YtDlpLiveCapturer(bin).record({ platform: "twitch", handle: "x", url: "https://www.twitch.tv/x" }, { durationSec: 5, dir, name: "s", signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    const started = Date.now();
    await expect(recording).rejects.toThrow("Stopped.");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("Kick", () => {
  const channel = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("reads the HLS address from the channel endpoint", async () => {
    const urls: string[] = [];
    const doFetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ slug: "n3on", playback_url: "https://x.playback.live-video.net/api/video/v1/c.m3u8?token=t" }));
    }) as unknown as typeof fetch;
    expect(await kickPlaybackUrl("N3on", doFetch)).toBe("https://x.playback.live-video.net/api/video/v1/c.m3u8?token=t");
    expect(urls).toEqual(["https://kick.com/api/v2/channels/n3on"]);
    expect(await kickPlaybackUrl("n3on", channel({ slug: "n3on" }))).toBeNull();
    expect(await kickPlaybackUrl("n3on", channel({ playback_url: "file:///etc/passwd" }))).toBeNull();
    expect(await kickPlaybackUrl("n3on", channel({}, 403))).toBeNull();
  });

  it("records Kick with ffmpeg on that address, everything else (and Kick without one) with yt-dlp", async () => {
    const used: string[] = [];
    const ytDlp: LiveCapturer = { name: "stub", record: async (t) => (used.push(`yt-dlp ${t.url}`), "y.ts") };
    const hls = async (url: string) => (used.push(`ffmpeg ${url}`), "f.ts");
    const opts = { durationSec: 5, dir, name: "s" };
    const kick = { platform: "kick" as const, handle: "n3on", url: "https://kick.com/n3on" };
    const withUrl = new PlatformLiveCapturer(ytDlp, { fetch: channel({ playback_url: "https://ivs.example/c.m3u8" }), recordHls: hls });
    await withUrl.record(kick, opts);
    await withUrl.record({ platform: "twitch", handle: "kai", url: "https://www.twitch.tv/kai" }, opts);
    await new PlatformLiveCapturer(ytDlp, { fetch: channel({}, 403), recordHls: hls }).record(kick, opts);
    expect(used).toEqual(["ffmpeg https://ivs.example/c.m3u8", "yt-dlp https://www.twitch.tv/kai", "yt-dlp https://kick.com/n3on"]);
  });
});

describe("recordHls (real ffmpeg on a generated stream served over local HTTP)", () => {
  it("copies the asked seconds of an HLS stream, video and audio", { timeout: 60_000 }, async () => {
    // A generated test pattern as an HLS playlist of 1 s parts: what a platform's player address serves.
    const hls = join(dir, "hls");
    await mkdir(hls);
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=8:size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac",
      "-f", "hls", "-hls_time", "1", "-hls_list_size", "0", join(hls, "live.m3u8"),
    ]);
    server = createServer((req, res) => {
      createReadStream(join(hls, basename(new URL(req.url ?? "/", "http://x").pathname)))
        .on("error", () => res.writeHead(404).end())
        .pipe(res);
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/live.m3u8?token=secret`;
    expect(ffmpegHlsArgs(url, 4, "out.ts").slice(4)).toEqual(["-i", url, "-t", "4", "-c", "copy", "-f", "mpegts", "out.ts"]);

    const out = join(dir, "out");
    await mkdir(out);
    const file = await recordHls(url, { durationSec: 4, dir: out, name: "segment-0" });
    expect(file).toBe(join(out, "segment-0.ts"));
    const info = await probeVideo(file);
    expect([info.width, info.height, info.hasAudio]).toEqual([320, 180, true]);
    expect(Math.abs(info.durationSec - 4)).toBeLessThanOrEqual(0.5);

    // A stream that is not there fails without showing the address (it carries a viewer token).
    const gone = recordHls(url.replace("live.m3u8", "gone.m3u8"), { durationSec: 4, dir: out, name: "segment-1" });
    await expect(gone).rejects.toThrow(/ffmpeg failed/);
    await expect(gone).rejects.not.toThrow(/secret/);
  });
});
