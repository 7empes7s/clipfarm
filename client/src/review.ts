import type { Clip, ClipStatus, Job, RejectReason, Source } from "../../shared/types";

// Review state for the gallery, kept pure so it can be unit tested: which list a clip is in, the
// inbox order, tab counts, and optimistic decisions with an undo for the last one.

export type ClipView = "inbox" | "approved" | "posted" | "rejected";

/** The list a clip shows in; null while its new version is being made (it shows in Jobs). */
export function clipView(c: Clip): ClipView | null {
  if (c.status === "pending") return "inbox";
  if (c.status === "rejected") return "rejected";
  if (c.status === "approved") return c.postCount > 0 ? "posted" : "approved";
  return null;
}

export function filterClips(clips: Clip[], view: ClipView, sourceId: number | null = null): Clip[] {
  return clips.filter((c) => clipView(c) === view && (sourceId === null || c.sourceId === sourceId));
}

/** Clips to review: newest VOD first, then the best score, then the newest clip. */
export function inboxQueue(clips: Clip[], sourceId: number | null = null): Clip[] {
  return filterClips(clips, "inbox", sourceId).sort(
    (a, b) => (b.vodId ?? 0) - (a.vodId ?? 0) || (b.score ?? -1) - (a.score ?? -1) || b.id - a.id,
  );
}

export interface TabCounts {
  inbox: number;
  approved: number;
  posted: number;
  rejected: number;
  sources: number;
  /** Jobs waiting or running. */
  jobs: number;
}

export function tabCounts(clips: Clip[], sources: Source[], jobs: Job[]): TabCounts {
  const counts: TabCounts = { inbox: 0, approved: 0, posted: 0, rejected: 0, sources: sources.length, jobs: 0 };
  for (const c of clips) {
    const v = clipView(c);
    if (v) counts[v]++;
  }
  counts.jobs = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  return counts;
}

export type Decision = "approve" | "reject";

export interface LastAction {
  clipId: number;
  action: Decision;
  prevStatus: ClipStatus;
  prevReason: RejectReason | null;
}

/** Applies a decision locally (before the server answers) and remembers how to take it back. */
export function decide(clips: Clip[], clipId: number, action: Decision, reason: RejectReason | null = null) {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return { clips, last: null };
  const last: LastAction = { clipId, action, prevStatus: clip.status, prevReason: clip.rejectReason };
  const status: ClipStatus = action === "approve" ? "approved" : "rejected";
  return {
    clips: clips.map((c) => (c.id === clipId ? { ...c, status, rejectReason: action === "reject" ? reason : null } : c)),
    last,
  };
}

export function undo(clips: Clip[], last: LastAction): Clip[] {
  return clips.map((c) => (c.id === last.clipId ? { ...c, status: last.prevStatus, rejectReason: last.prevReason } : c));
}

/** The clip to show once `id` is decided: the one after it, else the one before, else none. */
export function nextAfter(queue: Clip[], id: number): number | null {
  const i = queue.findIndex((c) => c.id === id);
  if (i === -1) return queue[0]?.id ?? null;
  return queue[i + 1]?.id ?? queue[i - 1]?.id ?? null;
}

/** Replaces clips with the server's copies. */
export function merge(clips: Clip[], updated: Clip[]): Clip[] {
  const byId = new Map(updated.map((c) => [c.id, c]));
  return clips.map((c) => byId.get(c.id) ?? c);
}
