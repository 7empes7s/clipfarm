import { STREAMER_RECHECK_DAYS, STREAMER_STATUSES, type StreamerEntry, type StreamerStatus } from "../../shared/catalog.js";
import type { PermissionKind } from "../../shared/types.js";
import type { Db } from "../db/index.js";
import { ValidationError } from "../errors.js";
import { isPublicWebUrl, judgeProof, type ProofFetcher } from "../sources/proof.js";
import type { SourcesRepo } from "../sources/repo.js";

const DAY = 86_400_000;
/** A page that could not be read is tried again the next day, not in a week. */
export const RETRY_DAYS = 1;

/** When an entry checked at `at` is checked again. */
export function nextCheckAt(at: Date, days = STREAMER_RECHECK_DAYS): string {
  return new Date(at.getTime() + days * DAY).toISOString();
}

/** The entries whose re-check is due, the most overdue first. */
export function dueEntries(entries: StreamerEntry[], now: Date): StreamerEntry[] {
  return entries.filter((e) => new Date(e.nextCheckAt).getTime() <= now.getTime()).sort((a, b) => a.nextCheckAt.localeCompare(b.nextCheckAt));
}

/** Whether the creator's clips may only go to burner accounts: the registry found no program for them (or lost its proof). */
export function noProgram(entry: StreamerEntry | undefined): boolean {
  return entry !== undefined && entry.status !== "program";
}

export interface SeedStreamer {
  name: string;
  status: StreamerStatus;
  program: string | null;
  proofUrl: string | null;
  proofQuote: string | null;
  checkedOn: string;
  note: string;
}

/** Checks the starting list (server/catalog/seed/streamers.json): a "program" entry needs its proof link. */
export function parseSeedStreamers(raw: unknown[]): SeedStreamer[] {
  return raw.map((x) => {
    const e = (x ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const name = str(e.name);
    const status = e.status as StreamerStatus;
    if (!name) throw new Error("A streamer in the registry seed has no name.");
    if (!STREAMER_STATUSES.includes(status)) throw new Error(`${name}: unknown status "${String(e.status)}".`);
    const proofUrl = str(e.proofUrl);
    if (status === "program" && (!proofUrl || !isPublicWebUrl(proofUrl))) throw new Error(`${name}: a program needs a public proof link.`);
    const checkedOn = str(e.checkedOn);
    if (!checkedOn || !/^\d{4}-\d{2}-\d{2}$/.test(checkedOn)) throw new Error(`${name}: checkedOn must be YYYY-MM-DD.`);
    return { name, status, program: str(e.program), proofUrl, proofQuote: str(e.proofQuote), checkedOn, note: str(e.note) ?? "" };
  });
}

interface Row {
  name: string;
  status: StreamerStatus;
  program: string | null;
  proof_url: string | null;
  proof_quote: string | null;
  checked_at: string;
  next_check_at: string;
  last_result: string;
  note: string;
}

const toEntry = (r: Row): StreamerEntry => ({
  name: r.name,
  status: r.status,
  program: r.program,
  proofUrl: r.proof_url,
  proofQuote: r.proof_quote,
  checkedAt: r.checked_at,
  nextCheckAt: r.next_check_at,
  lastResult: r.last_result,
  note: r.note,
});

export class RegistryRepo {
  constructor(private db: Db) {}

  /** Adds the seed's streamers that are not in the registry yet; what a re-check learned is kept. */
  seed(list: SeedStreamer[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO streamer_registry (name, status, program, proof_url, proof_quote, checked_at, next_check_at, last_result, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const s of list) {
        const at = new Date(`${s.checkedOn}T00:00:00Z`);
        insert.run(s.name, s.status, s.program, s.proofUrl, s.proofQuote, at.toISOString(), nextCheckAt(at), "From the starting list.", s.note);
      }
    })();
  }

  /** Programs first, then the rest, by name. */
  list(): StreamerEntry[] {
    return (this.db.prepare("SELECT * FROM streamer_registry ORDER BY status = 'program' DESC, name COLLATE NOCASE").all() as Row[]).map(toEntry);
  }

  find(name: string): StreamerEntry | undefined {
    const row = this.db.prepare("SELECT * FROM streamer_registry WHERE name = ?").get(name.trim()) as Row | undefined;
    return row ? toEntry(row) : undefined;
  }

  save(e: StreamerEntry): void {
    this.db
      .prepare(
        `UPDATE streamer_registry SET status = ?, program = ?, proof_url = ?, proof_quote = ?, checked_at = ?, next_check_at = ?, last_result = ? WHERE name = ?`,
      )
      .run(e.status, e.program, e.proofUrl, e.proofQuote, e.checkedAt, e.nextCheckAt, e.lastResult, e.name);
  }
}

export interface RegistryDeps {
  repo: RegistryRepo;
  sources: SourcesRepo;
  /** The fetch layer for proof pages (polite: robots.txt and a pause between pages). */
  fetcher: Pick<ProofFetcher, "fetchPage">;
  /** Campaign links the scout found for a creator, by name: proof that a "no program" creator now has one. */
  campaignsFor: (name: string) => string[];
  now?: () => Date;
}

/**
 * The streamer registry: re-checks every entry every 7 days, and keeps the "no program" creators'
 * clips off main accounts (a public allowance for them is refused, or put on hold).
 */
export class StreamerRegistry {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private deps: RegistryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  list(): StreamerEntry[] {
    return this.deps.repo.list();
  }

  /** Why a permission of this kind is refused for a creator, or null. Only a written permission or an experiment (burners) is taken for "no program" creators. */
  blockReason(creatorName: string, kind: PermissionKind): string | null {
    const e = this.deps.repo.find(creatorName);
    if (!noProgram(e) || kind !== "public-allowance") return null;
    return `${e!.name} has no public clipping program (streamer registry, checked ${e!.checkedAt.slice(0, 10)}), so a public allowance is not taken. Add their written permission, or run an experiment on burner accounts.`;
  }

  /** A campaign was imported for the creator: that is a program, with the campaign page as proof. */
  markProgram(creatorName: string, campaignUrl: string): void {
    const e = this.deps.repo.find(creatorName);
    if (!e || e.status === "program") return;
    const now = this.now();
    this.deps.repo.save({ ...e, status: "program", program: "Campaign imported in clipfarm", proofUrl: campaignUrl, proofQuote: null, checkedAt: now.toISOString(), nextCheckAt: nextCheckAt(now), lastResult: "A campaign for them was imported." });
  }

  /** Puts every public allowance of a "no program" creator on hold, so nothing of theirs posts to a main account. */
  enforce(): number {
    let held = 0;
    for (const s of this.deps.sources.list()) {
      const e = this.deps.repo.find(s.creatorName);
      if (!noProgram(e)) continue;
      for (const p of s.permissions.filter((p) => p.kind === "public-allowance" && p.reviewReason === null)) {
        this.deps.sources.flagForReview(p.id, `The streamer registry found no public clipping program for ${e!.name}. Add their written permission instead.`);
        held += 1;
      }
    }
    return held;
  }

  /** Checks one entry now and stores what came of it. */
  async check(name: string): Promise<StreamerEntry> {
    const e = this.deps.repo.find(name);
    if (!e) throw new ValidationError(`"${name}" is not in the streamer registry.`);
    const now = this.now();
    let next: StreamerEntry;
    if (e.status === "no-program" || !e.proofUrl) {
      const found = this.deps.campaignsFor(e.name)[0];
      next = found
        ? { ...e, status: "program", program: "Campaign found by the scout", proofUrl: found, proofQuote: null, lastResult: "The scout found a campaign for them." }
        : { ...e, status: "no-program", lastResult: "Still no clipping program found." };
    } else {
      let verdict;
      try {
        const page = await this.deps.fetcher.fetchPage(e.proofUrl);
        // Without a quote, a page that still answers counts.
        verdict = judgeProof(page, e.proofQuote ?? "");
      } catch (err) {
        verdict = { ok: false as const, gone: false, reason: `The page could not be reached (${err instanceof Error ? err.message : String(err)}).` };
      }
      if (verdict.ok) next = { ...e, status: "program", lastResult: "The proof page still shows it." };
      else if (verdict.gone) next = { ...e, status: "gone", lastResult: verdict.reason };
      else {
        // Nothing is known this time: the status stays, and it is tried again tomorrow.
        this.deps.repo.save({ ...e, nextCheckAt: nextCheckAt(now, RETRY_DAYS), lastResult: verdict.reason });
        return this.deps.repo.find(name)!;
      }
    }
    this.deps.repo.save({ ...next, checkedAt: now.toISOString(), nextCheckAt: nextCheckAt(now) });
    this.enforce();
    return this.deps.repo.find(name)!;
  }

  /** Checks every entry that is due, one after the other. */
  checkDue(): Promise<number> {
    const run = async () => {
      const due = dueEntries(this.deps.repo.list(), this.now());
      for (const e of due) await this.check(e.name);
      return due.length;
    };
    const next = this.running.then(run, run);
    this.running = next.catch(() => undefined);
    return next;
  }

  start(intervalMs: number): void {
    this.enforce();
    const tick = () => void this.checkDue().catch((err: unknown) => console.error("Streamer registry check failed:", err));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
