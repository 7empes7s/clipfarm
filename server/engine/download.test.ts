import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadVerified } from "./download.js";

// A made-up 300 kB "model" served by a local server: no real download in tests.
const FILE = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31 + (i >> 8)) & 0xff));
const SHA = createHash("sha256").update(FILE).digest("hex");

let dir: string;
let server: Server;
let url: string;
/** The Range header of each request, in order (undefined when there was none). */
let ranges: (string | undefined)[];
/** How the next requests behave. */
let mode: { cutAfter?: number; ignoreRange?: boolean };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clipfarm-download-"));
  ranges = [];
  mode = {};
  server = createServer((req, res) => {
    ranges.push(req.headers.range);
    const from = !mode.ignoreRange && req.headers.range ? Number(/bytes=(\d+)-/.exec(req.headers.range)![1]) : 0;
    if (from >= FILE.length) {
      res.writeHead(416).end();
      return;
    }
    const body = FILE.subarray(from);
    res.writeHead(from > 0 ? 206 : 200, { "Content-Length": body.length });
    if (mode.cutAfter !== undefined) {
      // The connection drops part-way, like a flaky network.
      res.write(body.subarray(0, mode.cutAfter), () => setTimeout(() => res.destroy(), 150));
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.bin`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe("downloadVerified", () => {
  it("downloads, reports progress up to the full size, and keeps the file when the checksum matches", async () => {
    const dest = join(dir, "models", "model.bin");
    const seen: [number, number][] = [];
    await downloadVerified({ url, dest, sha256: SHA, onProgress: (done, total) => seen.push([done, total]) });

    expect((await readFile(dest)).equals(FILE)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen[0]).toEqual([0, FILE.length]);
    expect(seen.at(-1)).toEqual([FILE.length, FILE.length]);
    expect(seen.every(([done], i) => i === 0 || done >= seen[i - 1]![0])).toBe(true);
  });

  it("carries on from where an interrupted download stopped instead of starting over", async () => {
    const dest = join(dir, "model.bin");
    mode = { cutAfter: 120_000 };
    await expect(downloadVerified({ url, dest, sha256: SHA })).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
    const kept = (await readFile(`${dest}.part`)).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(FILE.length);

    mode = {};
    const seen: [number, number][] = [];
    await downloadVerified({ url, dest, sha256: SHA, onProgress: (done, total) => seen.push([done, total]) });

    expect(ranges).toEqual([undefined, `bytes=${kept}-`]);
    expect(seen[0]).toEqual([kept, FILE.length]);
    expect((await readFile(dest)).equals(FILE)).toBe(true);
  });

  it("throws the file away and says so when the checksum does not match", async () => {
    const dest = join(dir, "model.bin");
    await expect(downloadVerified({ url, dest, sha256: "0".repeat(64) })).rejects.toThrow(
      "The download of model.bin did not match its checksum, so it was thrown away. Try again.",
    );
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("starts over when the server ignores the resume request", async () => {
    const dest = join(dir, "model.bin");
    await writeFile(`${dest}.part`, FILE.subarray(0, 1000));
    mode = { ignoreRange: true };
    await downloadVerified({ url, dest, sha256: SHA });
    expect((await readFile(dest)).equals(FILE)).toBe(true);
  });

  it("accepts a part that was already whole (the last try stopped before the check)", async () => {
    const dest = join(dir, "model.bin");
    await writeFile(`${dest}.part`, FILE);
    await downloadVerified({ url, dest, sha256: SHA, bytes: FILE.length });
    expect((await readFile(dest)).equals(FILE)).toBe(true);
  });

  it("says which file failed when the server refuses", async () => {
    await expect(downloadVerified({ url: url.replace("/model.bin", ""), dest: join(dir, "x.bin"), sha256: SHA, fetchImpl: async () => new Response("no", { status: 503 }) })).rejects.toThrow(
      "Downloading x.bin failed: the server answered 503.",
    );
  });
});
