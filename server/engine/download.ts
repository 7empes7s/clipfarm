import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadOptions {
  url: string;
  /** Where the finished, checked file goes. While downloading it is `<dest>.part`. */
  dest: string;
  sha256: string;
  /** Expected size, for progress when the server does not say. */
  bytes?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (doneBytes: number, totalBytes: number) => void;
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Downloads a file and only keeps it when its SHA-256 matches. An interrupted download leaves
 * `<dest>.part` behind and the next call carries on from there (HTTP Range) instead of starting over.
 */
export async function downloadVerified(o: DownloadOptions): Promise<void> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const name = basename(o.dest);
  const part = `${o.dest}.part`;
  await mkdir(dirname(o.dest), { recursive: true });

  let have = await sizeOf(part);
  let res = await fetchImpl(o.url, { headers: have > 0 ? { Range: `bytes=${have}-` } : undefined, signal: o.signal });
  if (res.status === 416) {
    // Nothing left to send: the part is whole (checked below). Any other odd part starts over.
    await res.body?.cancel();
    if (have !== o.bytes) {
      await rm(part, { force: true });
      have = 0;
      res = await fetchImpl(o.url, { signal: o.signal });
    }
  }
  if (res.status !== 416) {
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`Downloading ${name} failed: the server answered ${res.status}.`);
    }
    // 200 instead of 206 means the server ignored the Range header and is sending the whole file.
    if (res.status !== 206) have = 0;
    const total = have + (Number(res.headers.get("content-length")) || Math.max(0, (o.bytes ?? 0) - have));
    let done = have;
    o.onProgress?.(done, total);
    const out = createWriteStream(part, { flags: have > 0 ? "a" : "w" });
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on("data", (chunk: Buffer) => {
      done += chunk.length;
      o.onProgress?.(done, total);
    });
    await pipeline(body, out, { signal: o.signal });
  }

  if ((await sha256Of(part)) !== o.sha256) {
    await rm(part, { force: true });
    throw new Error(`The download of ${name} did not match its checksum, so it was thrown away. Try again.`);
  }
  await rename(part, o.dest);
}
