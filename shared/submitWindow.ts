import type { CampaignRules, PermissionKind } from "./types.js";

/**
 * Reach / Content Rewards campaigns pay only for a clip that is submitted within this many minutes
 * of going live. Whop has no clipper API, so the manager submits by hand.
 */
export const SUBMIT_WINDOW_MIN = 30;
/** The second push goes out this many minutes in, when the post is still not submitted. */
export const SUBMIT_REMIND_MIN = 20;

const MINUTE = 60_000;

/** "HH:MM" on a 24-hour clock. */
export interface DayHours {
  from: string;
  to: string;
}

/** When the manager can submit a campaign clip. Posts that need a submit go out only in these hours. */
export interface SubmitHours {
  /** Off: campaign clips go out by spacing alone, at any hour. */
  enabled: boolean;
  /** An IANA time zone, e.g. "Europe/Luxembourg". */
  timeZone: string;
  /** Monday to Friday. */
  weekdays: DayHours;
  /** Saturday and Sunday. */
  weekends: DayHours;
}

export const DEFAULT_SUBMIT_HOURS: SubmitHours = {
  enabled: true,
  timeZone: "Europe/Luxembourg",
  weekdays: { from: "08:00", to: "22:00" },
  weekends: { from: "08:00", to: "22:00" },
};

export const SNOOZES = ["1h", "3h", "today"] as const;
export type Snooze = (typeof SNOOZES)[number];
export const SNOOZE_LABELS: Record<Snooze, string> = { "1h": "1 hour", "3h": "3 hours", today: "Today" };

/** What the Dashboard and Settings show about the submit window. */
export interface SubmitWindowInfo {
  hours: SubmitHours;
  /** "I'm busy" until then; null when not snoozed (or the snooze is over). */
  snoozeUntil: string | null;
  /** Campaign posts that wait for their time, and when the next one goes out. */
  waiting: number;
  nextAt: string | null;
  /** Posts that are live right now and still have to be submitted. */
  open: number;
}

/** Whether a clip posted under this permission has to be submitted by hand within the window. */
export function needsManualSubmit(permission: { kind: PermissionKind; rules: CampaignRules | null }): boolean {
  return permission.kind === "whop-campaign" && (permission.rules?.manualSubmit ?? true);
}

/** "08:30" → 510; null when it is not a time. */
export function clockMinutes(hhmm: unknown): number | null {
  const m = typeof hhmm === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** The calendar date and the minutes since midnight that a moment has in a time zone. */
function localParts(t: number, timeZone: string): { y: number; m: number; d: number; min: number } {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formats.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(t))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year!, m: p.month!, d: p.day!, min: p.hour! * 60 + p.minute! };
}

/** How far the zone's clock is ahead of UTC at a moment. */
function offsetMs(t: number, timeZone: string): number {
  const p = localParts(t, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, 0, p.min) - Math.floor(t / MINUTE) * MINUTE;
}

/** The moment a zone's clock shows this date and time (`d` and `min` may run over: day 32, minute 1500). */
function zonedTime(y: number, m: number, d: number, min: number, timeZone: string): number {
  const wall = Date.UTC(y, m - 1, d, 0, min);
  // Twice: the first guess can land on the other side of a clock change.
  const first = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(first, timeZone);
}

export function isTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Clean submit hours, or what is wrong with them in plain words. */
export function parseSubmitHours(body: unknown): SubmitHours | string {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isTimeZone(b.timeZone)) return "Pick a time zone from the list.";
  const day = (v: unknown, label: string): DayHours | string => {
    const { from, to } = (v ?? {}) as Record<string, unknown>;
    const start = clockMinutes(from);
    const end = clockMinutes(to);
    if (start === null || end === null) return `${label} hours need a start and an end, like 08:00 and 22:00.`;
    if (end - start < 60) return `${label} hours must be at least an hour long, and end after they start.`;
    return { from: from as string, to: to as string };
  };
  const weekdays = day(b.weekdays, "Weekday");
  if (typeof weekdays === "string") return weekdays;
  const weekends = day(b.weekends, "Weekend");
  if (typeof weekends === "string") return weekends;
  return { enabled: b.enabled !== false, timeZone: b.timeZone, weekdays, weekends };
}

/**
 * The earliest time at or after `wanted` when a clip that needs a manual submit may go live: after
 * the snooze, and inside the submit hours with the whole window still ahead (the last post of a day
 * goes out SUBMIT_WINDOW_MIN before the hours end). Days and hours are the time zone's own, so a
 * clock change moves the slot with the manager's clock.
 */
export function nextSubmitTime(wanted: Date, hours: SubmitHours, snoozeUntil: Date | null = null): Date {
  const t = Math.max(wanted.getTime(), snoozeUntil?.getTime() ?? 0);
  if (!hours.enabled) return new Date(t);
  const { y, m, d } = localParts(t, hours.timeZone);
  // Today, then the days after: one of the next two always has room.
  for (let k = 0; k < 8; k++) {
    const weekday = new Date(Date.UTC(y, m - 1, d + k)).getUTCDay();
    const day = weekday === 0 || weekday === 6 ? hours.weekends : hours.weekdays;
    const open = zonedTime(y, m, d + k, clockMinutes(day.from) ?? 0, hours.timeZone);
    const last = zonedTime(y, m, d + k, (clockMinutes(day.to) ?? 24 * 60) - SUBMIT_WINDOW_MIN, hours.timeZone);
    if (t <= last) return new Date(Math.max(t, open));
  }
  return new Date(t);
}

/** When "I'm busy" ends: in 1 or 3 hours, or at midnight in the manager's time zone. */
export function snoozeEnd(now: Date, choice: Snooze, timeZone: string): Date {
  if (choice !== "today") return new Date(now.getTime() + (choice === "1h" ? 60 : 180) * MINUTE);
  const { y, m, d } = localParts(now.getTime(), timeZone);
  return new Date(zonedTime(y, m, d + 1, 0, timeZone));
}

export type SubmitAction = "notify" | "remind" | "miss";

/**
 * What is due for a live post that is still not submitted, `ageMin` minutes after it went live: the
 * first push, the reminder, or "window missed". A post first seen late gets one push, not two.
 */
export function submitAction(ageMin: number, done: { notified: boolean; reminded: boolean }): SubmitAction | null {
  if (ageMin < 0) return null;
  if (ageMin >= SUBMIT_WINDOW_MIN) return "miss";
  if (ageMin >= SUBMIT_REMIND_MIN) return done.reminded ? null : "remind";
  return done.notified ? null : "notify";
}

/** "08:05": a moment on the clock of a time zone. */
export function clockIn(at: Date, timeZone: string): string {
  const { min } = localParts(at.getTime(), timeZone);
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
