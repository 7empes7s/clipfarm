import { rmSync } from "node:fs";
import { accountsAllowedFor } from "../../shared/routing.js";
import {
  HOOK_LAB_HOURS,
  HOOK_PATTERN_LABELS,
  type HookLabInfo,
  type HookLabSettings,
  type HookPattern,
  type HookScore,
  type HookTest,
  type HookTestStatus,
} from "../../shared/trends.js";
import type { ChannelAccount, Permission, Post } from "../../shared/types.js";
import { PLATFORMS, POST_FLAGS } from "../../shared/types.js";
import type { ClipsRepo } from "../clips/repo.js";
import type { Db } from "../db/index.js";
import { ValidationError } from "../errors.js";
import type { ChatClient } from "../pipeline/picks/llm.js";
import type { Publisher } from "../publish/publisher.js";
import { says } from "../publish/compliance.js";
import type { PostsRepo } from "../publish/repo.js";
import { isActive, isExperimentOnly } from "../sources/permission.js";
import type { SourcesRepo } from "../sources/repo.js";
import { writeVariants } from "./variants.js";

export const HOOK_VARIANTS_JOB = "hook-variants";
/** Tests being made or running at once, so a full Approved list does not flood the burner accounts. */
const MAX_ACTIVE_TESTS = 3;
const MAX_VARIANTS = 3;
const HOUR = 3_600_000;
const NEEDS_BURNERS = "The hook lab needs at least 2 burner accounts on one platform, switched on. Mark accounts as Burner in Accounts.";

interface TestRow {
  id: number;
  clip_id: number;
  clip_title: string;
  status: HookTestStatus;
  note: string | null;
  ends_at: string | null;
  winner_variant_id: number | null;
  main_posts: number;
  created_at: string;
}

interface VariantRow {
  id: number;
  test_id: number;
  label: string;
  hook: string;
  title: string;
  pattern: HookPattern;
  account_id: string;
  account_name: string;
  file_path: string | null;
  rendered: number;
  post_id: number | null;
  views_per_hour: number | null;
}

export interface HookLabDeps {
  db: Db;
  clips: ClipsRepo;
  sources: SourcesRepo;
  posts: PostsRepo;
  publisher: Publisher;
  /** Queues the job that renders a test's variants (one heavy job at a time, like every render). */
  enqueueRender: (testId: number, clipId: number) => void;
  /** The AI writer for hooks; null (or left out) writes them from templates. */
  chat?: () => ChatClient | null;
  /** Hook patterns winning today (the trend radar), tried first. */
  trending?: () => HookPattern[];
  now?: () => Date;
}

const usable = (a: ChannelAccount) => a.role === "burner" && a.enabled && !a.disabled && a.health !== "banned";
const num = (n: number) => n.toLocaleString("en-US");

/** The burner accounts of one platform a clip's permissions route to: the platform with the most of them. */
function burnersFor(permissions: Permission[], accounts: ChannelAccount[], now: Date): ChannelAccount[] {
  const allowed = new Set(
    permissions.filter((p) => isActive(p, now)).flatMap((p) => accountsAllowedFor(p, accounts).map((a) => a.id)),
  );
  const burners = accounts.filter((a) => allowed.has(a.id) && usable(a));
  return PLATFORMS.map((platform) => burners.filter((a) => a.platform === platform)).sort((a, b) => b.length - a.length)[0]!;
}

/**
 * A/B tests of hooks: an approved clip gets 2-3 hook variants on the same cut, each posted to its
 * own burner account. After the window the variant with the most views per hour goes to the main
 * accounts. Every post goes through the publisher, so the permission gate and routing always hold.
 */
export class HookLab {
  private now: () => Date;
  private busy = false;

  constructor(private deps: HookLabDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  settings(): HookLabSettings {
    const row = this.deps.db.prepare("SELECT value FROM settings WHERE key = 'hook_lab'").get() as { value: string } | undefined;
    return { on: false, hours: HOOK_LAB_HOURS.default, ...(row ? (JSON.parse(row.value) as Partial<HookLabSettings>) : {}) };
  }

  saveSettings(raw: unknown): HookLabSettings {
    const b = (raw ?? {}) as { on?: unknown; hours?: unknown };
    const next = this.settings();
    if (b.on !== undefined) {
      if (typeof b.on !== "boolean") throw new ValidationError("Say whether the hook lab is on or off.");
      next.on = b.on;
    }
    if (b.hours !== undefined) {
      const hours = Number(b.hours);
      if (b.hours === null || b.hours === "" || !Number.isInteger(hours) || hours < HOOK_LAB_HOURS.min || hours > HOOK_LAB_HOURS.max) {
        throw new ValidationError(`Hours must be a whole number from ${HOOK_LAB_HOURS.min} to ${HOOK_LAB_HOURS.max}.`);
      }
      next.hours = hours;
    }
    this.deps.db
      .prepare("INSERT INTO settings (key, value) VALUES ('hook_lab', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  private tests(where = "1 = 1", ...args: unknown[]): TestRow[] {
    return this.deps.db
      .prepare(`SELECT t.*, c.title AS clip_title FROM hook_tests t JOIN clips c ON c.id = t.clip_id WHERE ${where} ORDER BY t.id`)
      .all(...args) as TestRow[];
  }

  private variants(testId: number): VariantRow[] {
    return this.deps.db.prepare("SELECT * FROM hook_variants WHERE test_id = ? ORDER BY id").all(testId) as VariantRow[];
  }

  /** Ends a test and deletes its variant videos, except those an upload is still waiting to send. */
  private end(testId: number, status: "done" | "stopped", note: string, winnerId: number | null = null, mainPosts = 0): void {
    this.deps.db
      .prepare("UPDATE hook_tests SET status = ?, note = ?, winner_variant_id = ?, main_posts = ? WHERE id = ?")
      .run(status, note, winnerId, mainPosts, testId);
    this.tidy();
  }

  /** Deletes the variant videos of ended tests once no waiting upload needs them. */
  private tidy(): void {
    const { db, posts } = this.deps;
    const left = db
      .prepare("SELECT v.id, v.file_path FROM hook_variants v JOIN hook_tests t ON t.id = v.test_id WHERE t.status IN ('done', 'stopped') AND v.file_path IS NOT NULL")
      .all() as { id: number; file_path: string }[];
    for (const v of left) {
      if (posts.waitsForFile(v.file_path)) continue;
      rmSync(v.file_path, { force: true });
      db.prepare("UPDATE hook_variants SET file_path = NULL WHERE id = ?").run(v.id);
    }
  }

  /** The variants of a test that still need their own video (A is the clip's own). */
  variantsToRender(testId: number): { id: number; clipId: number; label: string; hook: string }[] {
    const [test] = this.tests("t.id = ? AND t.status = 'rendering'", testId);
    if (!test) return [];
    return this.variants(testId)
      .filter((v) => v.rendered === 0)
      .map((v) => ({ id: v.id, clipId: test.clip_id, label: v.label, hook: v.hook }));
  }

  setVariantFile(variantId: number, filePath: string): void {
    this.deps.db.prepare("UPDATE hook_variants SET file_path = ?, rendered = 1 WHERE id = ?").run(filePath, variantId);
  }

  /** The render job ended without success: the test cannot go on. */
  renderFailed(testId: number, reason: string | null): void {
    if (this.tests("t.id = ? AND t.status = 'rendering'", testId).length === 0) return;
    this.end(testId, "stopped", `The hook variants could not be made${reason ? `: ${reason}` : "."} Nothing was sent.`);
  }

  /**
   * One pass, safe to call at any time: starts tests for approved clips, sends rendered variants
   * to their burner accounts, and settles tests whose window is over. Does nothing while off.
   */
  async tick(): Promise<void> {
    if (this.busy || !this.settings().on) return;
    this.busy = true;
    try {
      this.tidy();
      await this.start();
      await this.send();
      await this.finish();
    } finally {
      this.busy = false;
    }
  }

  private async start(): Promise<void> {
    const { db, clips, sources, publisher } = this.deps;
    let active = this.tests("t.status IN ('rendering', 'running')").length;
    const tested = new Set((db.prepare("SELECT clip_id FROM hook_tests").all() as { clip_id: number }[]).map((r) => r.clip_id));
    // Only clips nobody has posted yet: a test must not change what is already out.
    const waiting = clips.list().filter((c) => c.status === "approved" && c.postCount === 0 && !tested.has(c.id));
    if (waiting.length === 0 || active >= MAX_ACTIVE_TESTS) return;
    const accounts = await publisher.knownAccounts();
    const won = this.scoreboard().filter((s) => s.wins > 0).map((s) => s.pattern);
    for (const clip of waiting) {
      if (active >= MAX_ACTIVE_TESTS) break;
      const source = sources.get(clip.sourceId);
      const burners = burnersFor(source.permissions, accounts, this.now());
      if (burners.length < 2) continue;
      // A hook that breaks a campaign's rules is never written: the publisher would refuse it anyway.
      const banned = source.permissions.filter((p) => isActive(p, this.now())).flatMap((p) => p.rules?.bannedWords ?? []);
      const copies = await writeVariants({
        clip,
        creatorName: source.creatorName,
        count: Math.min(MAX_VARIANTS, burners.length),
        prefer: [...(this.deps.trending?.() ?? []), ...won],
        chat: this.deps.chat?.() ?? null,
        allowed: (c) => !banned.some((word) => says(`${c.title}\n${c.hook}`, word)),
      });
      if (copies.length < 2) {
        db.prepare("INSERT INTO hook_tests (clip_id, status, note, created_at) VALUES (?, 'stopped', ?, ?)").run(
          clip.id,
          "Every other hook would break the campaign's rules, so there was nothing to test. Nothing was sent.",
          this.now().toISOString(),
        );
        continue;
      }
      const testId = db.transaction(() => {
        const { lastInsertRowid } = db
          .prepare("INSERT INTO hook_tests (clip_id, status, created_at) VALUES (?, 'rendering', ?)")
          .run(clip.id, this.now().toISOString());
        const insert = db.prepare(
          "INSERT INTO hook_variants (test_id, label, hook, title, pattern, account_id, account_name, rendered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        );
        copies.forEach((c, i) => {
          const account = burners[i]!;
          insert.run(lastInsertRowid, "ABC"[i], c.hook, c.title, c.pattern, account.id, account.name, i === 0 ? 1 : 0);
        });
        return Number(lastInsertRowid);
      })();
      this.deps.enqueueRender(testId, clip.id);
      active++;
    }
  }

  private async send(): Promise<void> {
    const { db, clips, publisher } = this.deps;
    for (const test of this.tests("t.status = 'rendering'")) {
      const variants = this.variants(test.id);
      if (variants.some((v) => v.rendered === 0)) continue;
      const accounts = await publisher.knownAccounts();
      // Checked for every variant before the first is sent: a test never reaches a main account.
      const gone = variants.find((v) => !accounts.some((a) => a.id === v.account_id && a.role === "burner"));
      if (gone) {
        this.end(test.id, "stopped", `${gone.account_name} is no longer a burner account, so the test was stopped. Nothing was sent.`);
        continue;
      }
      let last = 0;
      try {
        for (const v of variants) {
          const variant = { title: v.title, hook: v.hook, filePath: v.file_path ?? clips.filePath(test.clip_id) };
          const out = await publisher.post(test.clip_id, [v.account_id], null, variant);
          const post = out.posts[0];
          if (!post || post.status === "failed") throw new Error(post?.error ?? out.skipped[0]?.reason ?? "The post was not sent.");
          db.prepare("UPDATE hook_variants SET post_id = ? WHERE id = ?").run(post.id, v.id);
          last = Math.max(last, new Date(post.scheduledAt).getTime());
        }
      } catch (err) {
        this.end(test.id, "stopped", `The test was stopped: ${(err as Error).message}`);
        continue;
      }
      // The window runs from the last variant going out (accounts post the same clip some time apart).
      const endsAt = new Date(last + this.settings().hours * HOUR).toISOString();
      db.prepare("UPDATE hook_tests SET status = 'running', ends_at = ? WHERE id = ?").run(endsAt, test.id);
    }
  }

  private postOf(v: VariantRow): Post | null {
    if (v.post_id === null) return null;
    try {
      return this.deps.posts.get(v.post_id);
    } catch {
      return null;
    }
  }

  private async finish(): Promise<void> {
    const { db, sources, clips, publisher } = this.deps;
    const now = this.now();
    const due = this.tests("t.status = 'running' AND t.ends_at <= ?", now.toISOString());
    if (due.length === 0) return;
    await publisher.refresh();
    for (const test of due) {
      const scored = this.variants(test.id).map((v) => {
        const post = this.postOf(v);
        // A variant that is not up (never went out, or was claimed, removed or struck) cannot win.
        const live = post !== null && post.status === "posted" && POST_FLAGS.every((f) => post.flags[f] === null);
        const hours = post ? Math.max(0.25, (now.getTime() - new Date(post.postedAt ?? post.scheduledAt).getTime()) / HOUR) : 1;
        const perHour = live ? Math.round((post.views ?? 0) / hours) : null;
        db.prepare("UPDATE hook_variants SET views_per_hour = ? WHERE id = ?").run(perHour, v.id);
        return { v, perHour };
      });
      const live = scored.filter((s) => s.perHour !== null);
      if (live.length === 0) {
        this.end(test.id, "stopped", "No variant is still up on a burner account, so there is no winner. Nothing went to a main account.");
        continue;
      }
      // The earlier label wins a tie, so with no views at all the clip goes out as it was approved.
      const winner = live.reduce((best, s) => (s.perHour! > best.perHour! ? s : best));
      const won = `${winner.v.label} won with ${num(winner.perHour!)} views an hour`;
      const clip = clips.get(test.clip_id);
      const mains = (await publisher.choices(clip.id)).filter((c) => c.canPost && c.account.role === "main");
      const picked = mains.some((c) => c.suggested) ? mains.filter((c) => c.suggested) : mains;
      if (picked.length === 0) {
        const why = isExperimentOnly(sources.get(clip.sourceId).permissions, now)
          ? "this creator is an experiment, which never goes to a main account"
          : "no main account can take this clip";
        this.end(test.id, "done", `${won}. It stays on the burner accounts: ${why}.`, winner.v.id);
        continue;
      }
      try {
        const variant = { title: winner.v.title, hook: winner.v.hook, filePath: winner.v.file_path ?? clips.filePath(clip.id) };
        const out = await publisher.post(clip.id, picked.map((c) => c.account.id), null, variant);
        const sent = out.posts.filter((p) => p.status !== "failed").length;
        this.end(test.id, "done", `${won} and went to ${sent} main account${sent === 1 ? "" : "s"}.`, winner.v.id, sent);
      } catch (err) {
        this.end(test.id, "done", `${won}, but it could not go to a main account: ${(err as Error).message} Post it from Approved.`, winner.v.id);
      }
    }
  }

  /** Per hook pattern: how often it was tested, how often it won, and its usual views per hour. */
  scoreboard(): HookScore[] {
    const rows = this.deps.db
      .prepare(
        `SELECT v.pattern, COUNT(*) AS tests, SUM(v.id = t.winner_variant_id) AS wins, AVG(v.views_per_hour) AS avg
         FROM hook_variants v JOIN hook_tests t ON t.id = v.test_id
         WHERE t.status = 'done' AND v.views_per_hour IS NOT NULL
         GROUP BY v.pattern ORDER BY wins DESC, avg DESC, v.pattern`,
      )
      .all() as { pattern: HookPattern; tests: number; wins: number; avg: number }[];
    return rows.map((r) => ({ pattern: r.pattern, label: HOOK_PATTERN_LABELS[r.pattern], tests: r.tests, wins: r.wins, avgViewsPerHour: Math.round(r.avg) }));
  }

  info(): HookLabInfo {
    const burners = this.deps.publisher.accounts.list().filter(usable);
    const byPlatform = PLATFORMS.map((p) => burners.filter((a) => a.platform === p).length);
    const tests: HookTest[] = this.tests()
      .reverse()
      .slice(0, 30)
      .map((t) => ({
        id: t.id,
        clipId: t.clip_id,
        clipTitle: t.clip_title,
        status: t.status,
        note: t.note,
        createdAt: t.created_at,
        endsAt: t.ends_at,
        mainPosts: t.main_posts,
        variants: this.variants(t.id).map((v) => ({
          id: v.id,
          label: v.label,
          hook: v.hook,
          title: v.title,
          pattern: v.pattern,
          accountName: v.account_name,
          postId: v.post_id,
          views: this.postOf(v)?.views ?? null,
          viewsPerHour: v.views_per_hour,
          winner: v.id === t.winner_variant_id,
        })),
      }));
    return { settings: this.settings(), note: byPlatform.some((n) => n >= 2) ? null : NEEDS_BURNERS, tests, scoreboard: this.scoreboard() };
  }
}
