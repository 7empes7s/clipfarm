import type { GoogleSettings, GoogleStatus } from "../../shared/google.js";
import type { Db } from "../db/index.js";
import { ValidationError } from "../errors.js";
import type { ChatClient } from "../pipeline/picks/llm.js";
import type { GeminiClient, GeminiImageRequest, GeminiJsonRequest, GeminiUsage } from "./client.js";

/** Google is not called: no connection, or the spend guard said stop. The message says which, plainly. */
export class GoogleUnavailableError extends Error {}

/** The free-trial credit on the clipfarm Google account ("Leonida Clips"), and its last day. */
export const DEFAULT_CREDIT_EUR = 269;
export const DEFAULT_CREDIT_EXPIRES = "2027-02-11";
/** Google is no longer called once this share of the credit is used. */
export const CREDIT_STOP_SHARE = 0.9;
/** List prices are in dollars, the credit is in euros. */
const DEFAULT_EUR_PER_USD = 0.92;

export const DEFAULT_GOOGLE_SETTINGS: GoogleSettings = { rerank: true, thumbnails: true, weight: 30, topN: 12, dailyCapEur: 3 };

/** List prices in USD per million tokens (Google's pricing page, read 2026-11-13). */
const PRICES: Record<string, { in: number; out: number }> = {
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
};
/** A model not in the list is priced as the dearest Flash, so the estimate errs on the high side. */
const UNKNOWN_FLASH = { in: 0.75, out: 3.75 };
/** Picture models: $30 per million output tokens, 1,290 tokens ($0.039) a picture. */
const IMAGE = { in: 0.3, out: 30 };

export function callCostUsd(usage: GeminiUsage): number {
  const price = /image|banana/i.test(usage.model) ? IMAGE : (PRICES[usage.model] ?? UNKNOWN_FLASH);
  return (usage.inTokens * price.in + usage.outTokens * price.out) / 1e6;
}

const eur = (n: number) => `€${n.toFixed(2)}`;
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

export interface GoogleAiOptions {
  /** The connection from Settings; null until a project and a credential are set. */
  client: () => GeminiClient | null;
  creditEur?: number;
  /** The credit's last day, YYYY-MM-DD. */
  expiresAt?: string;
  eurPerUsd?: number;
  /** Takes saved keys out of an error message before it is thrown on. */
  scrub?: (text: string) => string;
  now?: () => Date;
}

/**
 * Every call to Gemini goes through here: it is refused once the day's cap, 90% of the credit or
 * the credit's last day is reached, and each call's estimated cost is logged and added up.
 * Callers treat a refusal like any other failure and carry on with the local engine.
 */
export class GoogleAi {
  private db: Db | null = null;
  private readonly creditEur: number;
  private readonly expiresAt: string;
  readonly eurPerUsd: number;
  private readonly now: () => Date;

  constructor(private opts: GoogleAiOptions) {
    this.creditEur = opts.creditEur ?? DEFAULT_CREDIT_EUR;
    this.expiresAt = opts.expiresAt ?? DEFAULT_CREDIT_EXPIRES;
    this.eurPerUsd = opts.eurPerUsd ?? DEFAULT_EUR_PER_USD;
    this.now = opts.now ?? (() => new Date());
  }

  bind(db: Db): void {
    this.db = db;
  }

  /** A connection is set (and the database is open, so spend can be counted). */
  available(): boolean {
    return this.db !== null && this.opts.client() !== null;
  }

  settings(): GoogleSettings {
    const row = this.db?.prepare("SELECT value FROM settings WHERE key = 'google'").get() as { value: string } | undefined;
    return { ...DEFAULT_GOOGLE_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<GoogleSettings>) : {}) };
  }

  saveSettings(body: unknown): GoogleSettings {
    if (!this.db) throw new Error("Google settings cannot be saved before the database is open.");
    const b = (body ?? {}) as Record<string, unknown>;
    const next = { ...this.settings() };
    if (typeof b.rerank === "boolean") next.rerank = b.rerank;
    if (typeof b.thumbnails === "boolean") next.thumbnails = b.thumbnails;
    if (b.dailyCapEur !== undefined) {
      const cap = Number(b.dailyCapEur);
      if (b.dailyCapEur === "" || !Number.isFinite(cap) || cap < 0) throw new ValidationError("The daily limit must be a number of euros, zero or more.");
      next.dailyCapEur = cap;
    }
    if (b.weight !== undefined) {
      const weight = Number(b.weight);
      if (b.weight === "" || !Number.isFinite(weight) || weight < 0 || weight > 100) throw new ValidationError("How much the video counts must be from 0 to 100.");
      next.weight = Math.round(weight);
    }
    if (b.topN !== undefined) {
      const topN = Number(b.topN);
      if (!Number.isInteger(topN) || topN < 1 || topN > 30) throw new ValidationError("The number of picks to watch must be from 1 to 30.");
      next.topN = topN;
    }
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('google', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  private spent(): { total: number; today: number; calls: number } {
    const day = this.now().toISOString().slice(0, 10);
    const row = this.db?.prepare(
      "SELECT COALESCE(SUM(cost_eur), 0) AS total, COALESCE(SUM(CASE WHEN substr(at, 1, 10) = ? THEN cost_eur ELSE 0 END), 0) AS today, COUNT(*) AS calls FROM google_calls",
    ).get(day) as { total: number; today: number; calls: number } | undefined;
    return row ?? { total: 0, today: 0, calls: 0 };
  }

  /** Why Google must not be called right now, or null. */
  blocked(): string | null {
    if (this.now().toISOString().slice(0, 10) > this.expiresAt) return `The Google credit ended on ${this.expiresAt}, so Google is no longer called.`;
    const { total, today } = this.spent();
    if (total >= this.creditEur * CREDIT_STOP_SHARE) {
      return `${Math.round(CREDIT_STOP_SHARE * 100)}% of the Google credit (${eur(this.creditEur)}) is used, so Google is no longer called.`;
    }
    const cap = this.settings().dailyCapEur;
    if (today >= cap) return `Today's Google limit (${eur(cap)}) is reached.`;
    return null;
  }

  status(): GoogleStatus {
    const { total, today, calls } = this.spent();
    const configured = this.available();
    return {
      configured,
      settings: this.settings(),
      creditEur: this.creditEur,
      expiresAt: this.expiresAt,
      spentEur: round(total, 2),
      todayEur: round(today, 2),
      calls,
      blocked: configured ? this.blocked() : null,
    };
  }

  /** A JSON answer from Gemini Flash; `kind` names the use in the spend log (rerank, writer, test). */
  async json(kind: string, req: GeminiJsonRequest, signal?: AbortSignal): Promise<{ text: string; costUsd: number }> {
    const res = await this.guarded(kind, (client) => client.generateJson(req, signal));
    return { text: res.text, costUsd: res.costUsd };
  }

  /** A picture from Gemini image, built from a frame. */
  async image(kind: string, req: GeminiImageRequest, signal?: AbortSignal): Promise<{ image: Buffer; mimeType: string; costUsd: number }> {
    const res = await this.guarded(kind, (client) => client.generateImage(req, signal));
    return { image: res.image, mimeType: res.mimeType, costUsd: res.costUsd };
  }

  /** Gemini Flash as the chat model that writes hooks and titles; null without a connection. */
  chat(): ChatClient | null {
    const client = this.available() ? this.opts.client() : null;
    if (!client) return null;
    return {
      name: `gemini:${client.flashModel}`,
      complete: async (req, signal) => {
        const res = await this.json("writer", { system: req.system, text: req.user, schema: req.schema }, signal);
        return { content: res.text, costUsd: res.costUsd };
      },
    };
  }

  private async guarded<T extends GeminiUsage>(kind: string, call: (client: GeminiClient) => Promise<T>): Promise<T & { costUsd: number }> {
    const client = this.available() ? this.opts.client() : null;
    if (!client || !this.db) throw new GoogleUnavailableError("Google is not connected. Add it in Settings.");
    const stop = this.blocked();
    if (stop) throw new GoogleUnavailableError(stop);
    let res: T;
    try {
      res = await call(client);
    } catch (err) {
      if (err instanceof Error && this.opts.scrub) {
        err.message = this.opts.scrub(err.message);
        if (err.stack) err.stack = this.opts.scrub(err.stack);
      }
      throw err;
    }
    const costUsd = round(callCostUsd(res), 6);
    const costEur = costUsd * this.eurPerUsd;
    this.db
      .prepare("INSERT INTO google_calls (at, kind, model, in_tokens, out_tokens, cost_eur) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.now().toISOString(), kind, res.model, res.inTokens, res.outTokens, costEur);
    const cost = costEur >= 0.01 ? eur(costEur) : `€${costEur.toFixed(4)}`;
    console.log(
      `[google] ${kind} ${res.model}: ${res.inTokens} tokens in, ${res.outTokens} out, about ${cost} (today ${eur(this.spent().today)} of ${eur(this.settings().dailyCapEur)})`,
    );
    return { ...res, costUsd };
  }
}
