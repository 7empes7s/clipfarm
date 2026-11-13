import type { EngineReport, EngineUse } from "../../shared/types.js";
import type { Db } from "../db/index.js";
import { shares } from "../pipeline/transcript/chain.js";

/** One recorded job of the engine: a transcript or a round of picks. */
export interface EngineRun {
  vodId: number | null;
  report: EngineReport;
  createdAt: string;
}

/** Adds up the same step across several reports (a live stream is many short jobs). */
export function mergeUses(reports: EngineReport[]): EngineUse[] {
  const out = new Map<string, EngineUse>();
  for (const u of reports.flatMap((r) => r.uses)) {
    const x = out.get(u.step);
    if (!x) {
      out.set(u.step, { ...u });
      continue;
    }
    x.count += u.count;
    x.audioSec += u.audioSec;
    x.ms += u.ms;
    x.peakMb = u.peakMb === null ? x.peakMb : Math.max(x.peakMb ?? 0, u.peakMb);
    if (u.note && !x.note.split(", ").includes(u.note)) x.note = x.note ? `${x.note}, ${u.note}` : u.note;
  }
  return [...out.values()];
}

const seconds = (ms: number) => (ms < 950 ? "under 1 s" : ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/**
 * What a stream's card says about its engine, one line per stage with the time of each step, e.g.
 * "Transcript: Moonshine 92% in 41 s, Whisper small 8% (Spanish segment) in 12 s".
 */
export function vodEngineLines(reports: EngineReport[]): string[] {
  const lines: string[] = [];
  const stt = mergeUses(reports.filter((r) => r.kind === "stt")).filter((u) => u.count > 0);
  if (stt.length > 0) {
    const pct = shares(stt.map((u) => u.audioSec));
    lines.push(`Transcript: ${stt.map((u, i) => `${u.label} ${pct[i]}%${u.note ? ` (${u.note})` : ""} in ${seconds(u.ms)}`).join(", ")}`);
  }
  const picks = mergeUses(reports.filter((r) => r.kind === "picks")).filter((u) => u.count > 0);
  // Hooks taken from the transcript take no time worth telling.
  if (picks.length > 0) lines.push(`Picks: ${picks.map((u) => `${u.label} ${u.count}${u.step === "template" ? "" : ` in ${seconds(u.ms)}`}`).join(", ")}`);
  return lines;
}

/** A fallback's reason, sorted into a few plain kinds for the weekly summary. */
export function reasonKind(reason: string): string {
  if (/only knows English/.test(reason)) return "another language";
  if (/timed out/.test(reason)) return "timed out";
  if (/memory/i.test(reason)) return "not enough memory";
  if (/not downloaded|not installed|no OpenAI key|cannot run/i.test(reason)) return "not set up";
  if (/came out|low confidence|no words for|not usable/.test(reason)) return "poor result";
  return "failed";
}

/**
 * The week in a few lines: each step's share of the work, and how often and why it was passed
 * over. `names` gives the plain name of a step that was only ever passed over.
 */
export function weekLines(reports: EngineReport[], names: Record<string, string> = {}): string[] {
  const lines: string[] = [];
  for (const kind of ["stt", "picks"] as const) {
    const mine = reports.filter((r) => r.kind === kind);
    // Ranking by signals is not a hook writer: it has no share of the hooks.
    const uses = mergeUses(mine).filter((u) => u.step !== "signals");
    const pct = shares(uses.map((u) => (kind === "stt" ? u.audioSec : u.count)));
    const labels = new Map(uses.map((u) => [u.step, u.label]));
    const passed = new Map<string, Map<string, number>>();
    for (const f of mine.flatMap((r) => r.fallbacks)) {
      const kinds = passed.get(f.step) ?? new Map<string, number>();
      kinds.set(reasonKind(f.reason), (kinds.get(reasonKind(f.reason)) ?? 0) + f.count);
      passed.set(f.step, kinds);
    }
    for (const step of new Set([...uses.map((u) => u.step), ...passed.keys()])) {
      const i = uses.findIndex((u) => u.step === step);
      const share = i >= 0 && uses[i]!.count > 0 ? `${pct[i]}% of the ${kind === "stt" ? "audio" : "hooks"}` : "not used";
      const kinds = [...(passed.get(step) ?? [])].sort((a, b) => b[1] - a[1]);
      const times = kinds.reduce((sum, [, n]) => sum + n, 0);
      const why = times > 0 ? `. Passed over ${times} time${times === 1 ? "" : "s"}: ${kinds.map(([k, n]) => `${n} ${k}`).join(", ")}` : "";
      lines.push(`${labels.get(step) ?? names[step] ?? step}: ${share}${why}`);
    }
  }
  return lines;
}

/** Seconds of audio a step gets through per second on this server, from its recorded jobs; null before the first. */
export function measuredSpeed(reports: EngineReport[], step: string): number | null {
  const u = mergeUses(reports.filter((r) => r.kind === "stt")).find((x) => x.step === step);
  return u && u.audioSec > 0 && u.ms > 0 ? Math.round((u.audioSec / (u.ms / 1000)) * 10) / 10 : null;
}

/** The engine's job history (table `engine_runs`): what the Dashboard's engine card and stream cards read. */
export class EngineRuns {
  constructor(private db: Db) {}

  record(vodId: number | null, report: EngineReport, now = new Date()): void {
    this.db.prepare("INSERT INTO engine_runs (vod_id, kind, report, created_at) VALUES (?, ?, ?, ?)").run(vodId, report.kind, JSON.stringify(report), now.toISOString());
  }

  /** Newest first. */
  list(opts: { since?: Date; limit?: number } = {}): EngineRun[] {
    const rows = this.db
      .prepare("SELECT vod_id, report, created_at FROM engine_runs WHERE created_at >= ? ORDER BY id DESC LIMIT ?")
      .all(opts.since?.toISOString() ?? "", opts.limit ?? 2000) as { vod_id: number | null; report: string; created_at: string }[];
    return rows.map((r) => ({ vodId: r.vod_id, report: JSON.parse(r.report) as EngineReport, createdAt: r.created_at }));
  }

  /**
   * The runs that made a video's current transcript and picks: a new transcript or a new round
   * of picks replaces the one before, except on a live stream, where every segment adds to them.
   */
  forVod(vodId: number): EngineReport[] {
    return (
      this.db.prepare("SELECT report FROM engine_runs WHERE vod_id = ? ORDER BY id").all(vodId) as { report: string }[]
    ).map((r) => JSON.parse(r.report) as EngineReport);
  }

  /** Forgets a video's earlier runs of one kind, before a retry or a re-pick records the new one. */
  replace(vodId: number, report: EngineReport, now = new Date()): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM engine_runs WHERE vod_id = ? AND kind = ?").run(vodId, report.kind);
      this.record(vodId, report, now);
    })();
  }
}
