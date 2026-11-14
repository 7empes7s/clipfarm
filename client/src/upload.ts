import { UPLOAD_CHUNK_BYTES } from "../../shared/creator";
import { api } from "./api";

const RETRIES = 5;

function key(file: File): string {
  return `clipfarm.upload.${file.name}.${file.size}.${file.lastModified}`;
}

function remember(file: File, id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(key(file));
    else localStorage.setItem(key(file), String(id));
  } catch {
    /* private mode: a reload starts the file over */
  }
}

function remembered(file: File): number | null {
  try {
    return Number(localStorage.getItem(key(file))) || null;
  } catch {
    return null;
  }
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Stopped", "AbortError"));
    });
  });

/**
 * Sends a file in 8 MB pieces. A dropped connection is retried, and a file picked again after a
 * reload carries on where the server stopped. Returns the finished upload's id.
 */
export async function sendFile(file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<number> {
  let upload = null;
  const known = remembered(file);
  if (known) upload = await api.upload(known).catch(() => null);
  if (!upload || upload.sizeBytes !== file.size || upload.fileName !== file.name) {
    upload = await api.startUpload(file.name, file.size);
    remember(file, upload.id);
  }
  let offset = upload.receivedBytes;
  let failures = 0;
  onProgress(offset / file.size);
  while (offset < file.size) {
    signal.throwIfAborted();
    try {
      const res = await api.uploadPiece(upload.id, offset, file.slice(offset, offset + UPLOAD_CHUNK_BYTES));
      if (res.status === 409) {
        offset = (await api.upload(upload.id)).receivedBytes;
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { receivedBytes?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}.`);
      offset = body.receivedBytes ?? offset;
      failures = 0;
      onProgress(offset / file.size);
    } catch (err) {
      // A refusal with a reason is final; a lost connection is tried again a few times.
      if (!(err instanceof TypeError) || ++failures > RETRIES) {
        throw err instanceof TypeError ? new Error("The connection dropped. Pick the same file again to carry on where it stopped.") : err;
      }
      await wait(2000 * failures, signal);
    }
  }
  remember(file, null);
  return upload.id;
}
