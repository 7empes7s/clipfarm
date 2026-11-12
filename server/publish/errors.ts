import { HttpError } from "../errors.js";

/** The posting service failed or refused; the message is plain and never contains a key. */
export class PostingServiceError extends HttpError {
  constructor(message: string) {
    super(502, message);
  }
}

export interface ServiceVoice {
  label: string;
  /** Never shown: scrubbed out of any message the service sends back. */
  secret: string;
  refusedKey: string;
  limited: (detail: string) => string;
  unreachable: (reason: string) => string;
}

function networkReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "no answer in time";
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
}

function detailOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { msg?: unknown; error?: unknown; message?: unknown };
    const msg = parsed.msg ?? parsed.error ?? parsed.message;
    if (typeof msg === "string") return msg;
  } catch {
    // not JSON
  }
  return body.slice(0, 200);
}

/** Calls a posting service and returns its JSON, or throws a PostingServiceError in plain words. */
export async function callService<T>(doFetch: typeof fetch, url: string, init: RequestInit, voice: ServiceVoice): Promise<T> {
  const scrub = (s: string) => (voice.secret ? s.split(voice.secret).join("***") : s);
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(120_000) });
  } catch (error) {
    throw new PostingServiceError(scrub(voice.unreachable(networkReason(error))));
  }
  const body = await res.text();
  if (res.status === 401) throw new PostingServiceError(voice.refusedKey);
  if (res.status === 429) throw new PostingServiceError(scrub(voice.limited(detailOf(body))));
  if (!res.ok) {
    const detail = detailOf(body);
    throw new PostingServiceError(scrub(`${voice.label} answered with an error (HTTP ${res.status})${detail ? `: ${detail}` : "."}`));
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new PostingServiceError(`${voice.label} sent an answer that is not JSON. Is the address right?`);
  }
}
