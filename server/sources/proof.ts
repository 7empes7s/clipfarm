import { isIP } from "node:net";
import type { AllowanceFind, Permission, WatchChannel } from "../../shared/types.js";
import { ALLOWANCE_RECHECK_DAYS } from "../../shared/types.js";
import { channelUrl } from "../../shared/watchlist.js";
import { ValidationError } from "../errors.js";
import type { SourcesRepo } from "./repo.js";

export interface ProofPage {
  status: number;
  text: string;
}

/** Reads a public web page. The real one uses fetch; tests and CLIPFARM_FAKES use the fake. */
export interface ProofFetcher {
  name: string;
  fetchPage(url: string, signal?: AbortSignal): Promise<ProofPage>;
}

const MAX_PAGE_CHARS = 3_000_000;

/** Proof links come from the manager; the server never fetches its own network for them. */
export function isPublicWebUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isIP(host) === 6) return false;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return host.includes(".");
}

export class HttpProofFetcher implements ProofFetcher {
  readonly name = "http";

  constructor(private doFetch: typeof fetch = fetch) {}

  async fetchPage(url: string, signal?: AbortSignal): Promise<ProofPage> {
    let target = url;
    // Redirects are followed by hand, so none can lead into the server's own network.
    for (let hop = 0; hop < 5; hop++) {
      const res = await this.doFetch(target, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; clip-permission-check)", Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
        redirect: "manual",
        signal: signal ?? AbortSignal.timeout(20_000),
      });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!next) return { status: res.status, text: (await res.text()).slice(0, MAX_PAGE_CHARS) };
      target = new URL(next, target).toString();
      if (!isPublicWebUrl(target)) throw new Error("it redirects to an address that is not a public web page");
    }
    throw new Error("too many redirects");
  }
}

export const FAKE_ALLOWANCE_TEXT = "Clipping is allowed: you can clip my streams and post them anywhere, just credit the channel.";

/**
 * No network. Pages given to it are served as written; any other link is a page that allows
 * clipping, unless the link contains "gone" (a 404) or "silent" (a page that does not say it).
 */
export class FakeProofFetcher implements ProofFetcher {
  readonly name = "fake";

  constructor(private pages: Record<string, ProofPage> = {}) {}

  set(url: string, page: ProofPage): void {
    this.pages[url] = page;
  }

  fetchPage(url: string): Promise<ProofPage> {
    const known = this.pages[url];
    if (known) return Promise.resolve(known);
    if (url.includes("gone")) return Promise.resolve({ status: 404, text: "Not found" });
    if (url.includes("silent")) return Promise.resolve({ status: 200, text: "<p>Streams every day. Business: mail the team.</p>" });
    return Promise.resolve({ status: 200, text: `<html><body><p>${FAKE_ALLOWANCE_TEXT}</p></body></html>` });
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
};

/** "&amp;" and "&#39;" as the characters they stand for. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** The words of a page (HTML or JSON) as one lower-case line, so a quote can be looked up in it. */
export function pageText(raw: string): string {
  return decodeEntities(
    raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\[nrt]/g, " ")
      .replace(/\\(["'/])/g, "$1")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type ProofVerdict =
  | { ok: true }
  /** The proof is gone: the allowance needs review. */
  | { ok: false; gone: true; reason: string }
  /** The page could not be read this time: nothing is known, nothing changes. */
  | { ok: false; gone: false; reason: string };

/** Whether a fetched page still carries the quoted words. */
export function judgeProof(page: ProofPage, quote: string): ProofVerdict {
  if (page.status === 404 || page.status === 410) {
    return { ok: false, gone: true, reason: `The page with their words is gone (it answers "${page.status} not found").` };
  }
  if (page.status < 200 || page.status >= 300) {
    return { ok: false, gone: false, reason: `The page could not be read (it answered ${page.status}). Nothing was changed; try again later.` };
  }
  if (pageText(page.text).includes(pageText(quote))) return { ok: true };
  return { ok: false, gone: true, reason: `The page no longer says "${quote}".` };
}

const ALLOWS = [
  /\b(?:you|anyone|everyone|anybody|everybody|people|clippers?|fans|viewers)\s+(?:can|may|are\s+(?:free|allowed|welcome|encouraged)\s+to|is\s+(?:free|allowed|welcome)\s+to|have\s+(?:my\s+)?permission\s+to)\s+(?:freely\s+)?(?:clip|re-?upload|upload|post|use|share)\b/i,
  /\b(?:feel\s+free|free)\s+to\s+(?:clip|re-?upload|upload|post|use|share)\b[^.!?]{0,60}\b(?:clips?|streams?|content|vods?|videos?)\b/i,
  /\bclip(?:s|ping)?\s+(?:is|are)\s+(?:allowed|welcome|encouraged|permitted|fine|ok(?:ay)?)\b/i,
  /\b(?:i|we)\s+allow\s+(?:anyone\s+to\s+)?(?:clip|clips|clipping)\b/i,
  /\bclipping\s+(?:program|campaign)\b/i,
  /\bget\s+paid\s+to\s+clip\b/i,
];
const FORBIDS = /\b(?:not|no|don'?t|never|without|forbidden|prohibited)\b/i;

/** The sentence on a page that clearly allows clipping, or null. A sentence that also forbids something is passed over. */
export function findAllowanceQuote(raw: string): string | null {
  // Tags become sentence breaks, so a heading or panel title is never glued to the next line.
  const sentences = raw
    .replace(/<[^>]*>/g, " . ")
    .replace(/\\[nrt]/g, " . ")
    .split(/(?<=[.!?])\s+|\s*[\n\r|•"]+\s*/)
    .map((s) => s.replace(/^[\s."',:;-]+|[\s"',:;-]+$/g, "").replace(/\s+/g, " "))
    .filter((s) => s.length >= 12 && s.length <= 240);
  for (const s of sentences) {
    if (!/[{}\\<>]/.test(s) && ALLOWS.some((re) => re.test(s)) && !FORBIDS.test(s)) return s;
  }
  return null;
}

/** The public page that carries a channel's own description. */
export function aboutPageUrl(channel: WatchChannel): string {
  // Kick's site needs a browser; its public channel endpoint carries the same bio as text.
  if (channel.platform === "kick") return `https://kick.com/api/v2/channels/${encodeURIComponent(channel.handle.toLowerCase())}`;
  return `${channelUrl(channel)}/about`;
}

export interface CheckResult {
  ok: boolean;
  /** What happened, in plain words. */
  message: string;
}

/** Re-reads the proof of public allowances: on demand ("Check again") and on a timer, once a week each. */
export class AllowanceChecker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private deps: { sources: SourcesRepo; fetcher: ProofFetcher; now?: () => Date }) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Checks one permission record now and stores the outcome. */
  async check(permissionId: number): Promise<CheckResult> {
    const permission = this.deps.sources.permission(permissionId);
    if (permission.kind !== "public-allowance" || !permission.proofUrl || !permission.proofQuote) {
      throw new ValidationError("Only a public clipping allowance has a proof page to check.");
    }
    return this.recheck(permission);
  }

  private async recheck(p: Permission): Promise<CheckResult> {
    const { sources, fetcher } = this.deps;
    let verdict: ProofVerdict;
    if (!isPublicWebUrl(p.proofUrl!)) {
      verdict = { ok: false, gone: false, reason: "The proof link is not a public web page, so it cannot be checked." };
    } else {
      try {
        verdict = judgeProof(await fetcher.fetchPage(p.proofUrl!), p.proofQuote!);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        verdict = { ok: false, gone: false, reason: `The page could not be reached (${why}). Nothing was changed; try again later.` };
      }
    }
    if (verdict.ok) {
      sources.confirmProof(p.id, this.now());
      return { ok: true, message: "The page still says it. Checked just now." };
    }
    if (verdict.gone) sources.flagForReview(p.id, verdict.reason);
    return { ok: false, message: verdict.reason };
  }

  /** Checks every allowance whose proof was last seen a week or more ago, one after the other. */
  checkDue(): Promise<number> {
    const run = async () => {
      const due = this.deps.sources.allowancesCheckedBefore(new Date(this.now().getTime() - ALLOWANCE_RECHECK_DAYS * 86_400_000));
      for (const p of due) await this.recheck(p);
      return due.length;
    };
    const next = this.running.then(run, run);
    this.running = next.catch(() => undefined);
    return next;
  }

  /** Looks for due checks every `intervalMs`; each allowance still comes up once a week. */
  start(intervalMs: number): void {
    const tick = () => void this.checkDue().catch((err: unknown) => console.error("Allowance check failed:", err));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads a creator's own channel pages and reports the first clear clipping allowance on them. */
  async find(channels: WatchChannel[]): Promise<AllowanceFind> {
    const unread: string[] = [];
    for (const channel of channels) {
      const url = aboutPageUrl(channel);
      try {
        const page = await this.deps.fetcher.fetchPage(url);
        const quote = page.status >= 200 && page.status < 300 ? findAllowanceQuote(page.text) : null;
        // Only a quote the weekly check can find again on the same page counts.
        if (quote && judgeProof(page, quote).ok) return { found: { proofUrl: url, proofQuote: quote, checkedAt: this.now().toISOString() }, note: "Found on their page." };
        if (page.status < 200 || page.status >= 300) unread.push(channelUrl(channel));
      } catch {
        unread.push(channelUrl(channel));
      }
    }
    return {
      found: null,
      note: unread.length
        ? `Could not read ${unread.join(", ")}. Open the page yourself; if it allows clipping, add the proof in Sources.`
        : "Their pages do not clearly say clipping is allowed. If they say it elsewhere (Discord, a post), add that proof in Sources.",
    };
  }
}
