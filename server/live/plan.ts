import type { PermissionState } from "../../shared/types.js";
import { matchVod, mentionsGame, mentionsLeak, NEEDS_PERMISSION } from "../sources/watchlist/match.js";
import { SECTION_PAD_SEC, type Section } from "../pipeline/render/section.js";

/** The game whose launch the card counts down to. Before the launch time its streams are never recorded. */
export const LAUNCH_GAME = "GTA VI";
/** 19 November 2026, midnight US Eastern. The manager can change it on the Launch day card. */
export const DEFAULT_LAUNCH_AT = "2026-11-19T05:00:00.000Z";

export const LEAK_REASON = `${LAUNCH_GAME} before launch time counts as a leak, so it is not recorded.`;
export const SKIP_REASON = "Skipped: the server fell behind on live streams, so this segment was left out to keep up.";

export interface LaunchSettings {
  launchAt: string;
  /** The last Arm or Disarm tap; null when neither was tapped: live mode arms itself at launch time. */
  manual: { armed: boolean; at: string } | null;
  /** Watchlist ids whose switch is off. */
  off: number[];
}

export function beforeLaunch(s: LaunchSettings, now: Date): boolean {
  return now.getTime() < new Date(s.launchAt).getTime();
}

/** Whether live mode is on. Off until launch time unless armed by hand; then on unless disarmed since. */
export function isArmed(s: LaunchSettings, now: Date): boolean {
  if (!s.manual) return !beforeLaunch(s, now);
  if (s.manual.armed) return true;
  // A Disarm from before launch time does not outlive it: at the time, live mode arms itself.
  return !beforeLaunch(s, now) && new Date(s.manual.at).getTime() < new Date(s.launchAt).getTime();
}

export function launchStatusLine(s: LaunchSettings, now: Date): string {
  const armed = isArmed(s, now);
  if (beforeLaunch(s, now)) {
    return armed
      ? `Armed for other games. ${LAUNCH_GAME} streams are not recorded before launch time: early copies count as leaks.`
      : `Off until launch time, then it arms itself. ${LAUNCH_GAME} streams are not recorded before it: early copies count as leaks.`;
  }
  return armed ? "Armed: recording every permitted creator who is live with their games." : "Disarmed: nothing is recorded until you tap Arm.";
}

export interface CaptureCheck {
  armed: boolean;
  beforeLaunch: boolean;
  /** The per-creator switch. */
  creatorOn: boolean;
  permission: PermissionState;
  live: { title: string; game: string | null } | null;
  games: string[];
}

export type CaptureDecision = { capture: true } | { capture: false; reason: string };

/**
 * Whether a watched creator's live stream is recorded. The permission gate comes first, as for
 * VODs; then the leak rules, which no switch can turn off; then the switches.
 */
export function decideCapture(c: CaptureCheck): CaptureDecision {
  if (!c.live) return { capture: false, reason: "Not live" };
  if (c.permission !== "active") {
    return { capture: false, reason: c.permission === "expired" ? "Permission expired: renew it in their program" : NEEDS_PERMISSION };
  }
  if (mentionsLeak(c.live.title)) return { capture: false, reason: "The title mentions a leak" };
  const isLaunchGame = mentionsGame(c.live.title, LAUNCH_GAME) || (c.live.game !== null && mentionsGame(c.live.game, LAUNCH_GAME));
  if (c.beforeLaunch && isLaunchGame) return { capture: false, reason: LEAK_REASON };
  if (!matchVod({ title: c.live.title, category: c.live.game }, c.games).matched) return { capture: false, reason: "Not streaming one of their games" };
  if (!c.armed) return { capture: false, reason: c.beforeLaunch ? "Live mode is off until launch time" : "Live mode is disarmed" };
  if (!c.creatorOn) return { capture: false, reason: "Switched off for this creator" };
  return { capture: true };
}

export interface GuardLimits {
  minFreeDiskBytes: number;
  minMemAvailableBytes: number;
}

export const DEFAULT_GUARD: GuardLimits = { minFreeDiskBytes: 10e9, minMemAvailableBytes: 1e9 };

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Why a new recording must not start (too little disk or memory), in plain words; null when it may. */
export function guardReason(now: { freeDiskBytes: number; memAvailableBytes?: number }, limits: GuardLimits = DEFAULT_GUARD): string | null {
  if (now.freeDiskBytes < limits.minFreeDiskBytes) {
    return `Not recording: only ${gb(now.freeDiskBytes)} of disk is free, and live mode needs ${gb(limits.minFreeDiskBytes)}.`;
  }
  if (now.memAvailableBytes !== undefined && now.memAvailableBytes < limits.minMemAvailableBytes) {
    return `Not recording: only ${gb(now.memAvailableBytes)} of memory is free, and live mode needs ${gb(limits.minMemAvailableBytes)}.`;
  }
  return null;
}

export interface SegmentTimes {
  /** Seconds from the start of the recording. */
  startSec: number;
  durationSec: number;
}

/**
 * Whether the next rolling segment should start. Each one runs `stepSec` plus the overlap, and a
 * new one starts every `stepSec`, so two neighbours share the overlap.
 */
export function segmentDue(lastStartSec: number | null, elapsedSec: number, stepSec: number): boolean {
  return lastStartSec === null || elapsedSec - lastStartSec >= stepSec;
}

/**
 * The recorded segment that holds a moment whole. With an overlap as long as the longest clip,
 * every moment is whole in at least one segment, also when it crosses a boundary. Of several, the
 * one with the most room around the moment wins.
 */
export function coveringSegment<T extends SegmentTimes>(segments: T[], startSec: number, endSec: number, toleranceSec = 0.25): T | null {
  const room = (s: T) => Math.min(startSec - s.startSec, s.startSec + s.durationSec - endSec);
  const holding = segments.filter((s) => room(s) >= -toleranceSec);
  return holding.sort((a, b) => room(b) - room(a))[0] ?? null;
}

/** The part of a segment to cut for a pick: the pick plus padding, kept inside the segment. */
export function sectionWithin(seg: SegmentTimes, startSec: number, endSec: number, pad = SECTION_PAD_SEC): Section {
  const segEnd = seg.startSec + seg.durationSec;
  return {
    startSec: Math.max(seg.startSec, Math.floor((startSec - pad) * 10) / 10),
    endSec: Math.min(segEnd, Math.ceil((endSec + pad) * 10) / 10),
  };
}

/** Live work runs before stream/VOD work (priority 0): clips first, then segments, the biggest creator first. */
export function livePriority(watchlistRank: number, kind: "segment" | "clip"): number {
  return (kind === "clip" ? 2000 : 1000) + Math.max(0, 500 - watchlistRank);
}

/** The waiting segment jobs to give up on, oldest first, so that at most `max` wait. */
export function overBacklog<T>(queuedOldestFirst: T[], max: number): T[] {
  return queuedOldestFirst.slice(0, Math.max(0, queuedOldestFirst.length - max));
}

/** Whether a segment's video may be deleted: older than `keepHours` and no clip still to be cut from it. */
export function segmentExpired(seg: { startedAt: string; pendingPicks: number }, now: Date, keepHours: number): boolean {
  return seg.pendingPicks === 0 && now.getTime() - new Date(seg.startedAt).getTime() > keepHours * 3600_000;
}
