import type { CampaignDraft, Permission } from "../../../shared/types.js";
import { HttpError, ValidationError } from "../../errors.js";
import type { ChatClient } from "../../pipeline/picks/llm.js";
import type { CheckResult, ProofFetcher } from "../proof.js";
import type { SourcesRepo } from "../repo.js";
import { type CampaignFacts, extractCampaign, fieldsToCheck, fillWithChat, isCampaignUrl } from "./extract.js";

/** A campaign is read again once a day. */
export const CAMPAIGN_RECHECK_HOURS = 24;

/** The campaign page could not be read: the manager can paste its text, or fill the form by hand. */
export class CampaignUnreadError extends HttpError {
  constructor(why: string) {
    super(422, `The campaign page could not be read (${why}). Copy everything on the page and paste it below, or fill the form in by hand.`);
  }
}

export interface CampaignsDeps {
  sources: SourcesRepo;
  /** The fetch layer for public pages; a fake in tests and demo mode. */
  fetcher: ProofFetcher;
  /** A chat model that may fill what the page's labels left empty; null when there is none to use. */
  chat?: () => ChatClient | null;
  now?: () => Date;
}

/** Reads Whop / Content Rewards campaign pages: once to fill the form, then daily to see they still run. */
export class Campaigns {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private deps: CampaignsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The form's starting values for a pasted campaign link, read from its public page (or from the
   * page's text, pasted when the page cannot be fetched). Nothing is saved.
   */
  async read(rawUrl: unknown, pastedText?: unknown): Promise<CampaignDraft> {
    const campaignUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!isCampaignUrl(campaignUrl)) {
      throw new ValidationError("Paste a campaign link from whop.com or contentrewards.com (starting with https://).");
    }
    const pasted = typeof pastedText === "string" ? pastedText.trim().slice(0, 200_000) : "";
    const raw = pasted || (await this.page(campaignUrl));
    let facts: CampaignFacts = extractCampaign(raw);
    const chat = this.deps.chat?.();
    if (chat) {
      try {
        facts = await fillWithChat(facts, raw, chat);
      } catch {
        // The model is a help, not a need: what it would have filled stays marked "check this".
      }
    }
    const { sources } = this.deps;
    const name = facts.creatorName?.toLowerCase();
    const known = sources.findCampaign(campaignUrl);
    const existing = known ? sources.get(known.sourceId) : sources.list().find((s) => s.creatorName.toLowerCase() === name);
    return { campaignUrl, ...facts, check: fieldsToCheck(facts), existingSource: existing?.creatorName ?? null };
  }

  private async page(url: string): Promise<string> {
    let page;
    try {
      page = await this.deps.fetcher.fetchPage(url);
    } catch (err) {
      throw new CampaignUnreadError(err instanceof Error ? err.message : String(err));
    }
    if (page.status < 200 || page.status >= 300) throw new CampaignUnreadError(`it answered ${page.status}`);
    return page.text;
  }

  /** Reads one campaign's page now and stores the outcome ("Check again"). */
  async check(permissionId: number): Promise<CheckResult> {
    const permission = this.deps.sources.permission(permissionId);
    if (permission.kind !== "whop-campaign" || !permission.campaignUrl || !isCampaignUrl(permission.campaignUrl)) {
      throw new ValidationError("Only a campaign with a whop.com or contentrewards.com link has a page to check.");
    }
    return this.recheck(permission);
  }

  private async recheck(p: Permission): Promise<CheckResult> {
    const { sources, fetcher } = this.deps;
    const now = this.now();
    let page;
    try {
      page = await fetcher.fetchPage(p.campaignUrl!);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `The campaign page could not be reached (${why}). Nothing was changed; try again later.` };
    }
    let paused: string | null;
    let budgetLeftUsd: number | null = null;
    if (page.status === 404 || page.status === 410) {
      paused = `The campaign page is gone (it answers "${page.status} not found").`;
    } else if (page.status < 200 || page.status >= 300) {
      return { ok: false, message: `The campaign page could not be read (it answered ${page.status}). Nothing was changed; try again later.` };
    } else {
      // The page's own words only: a model's reading never pauses a source.
      const facts = extractCampaign(page.text);
      budgetLeftUsd = facts.rules.budgetLeftUsd;
      paused = facts.ended;
      if (!paused && facts.expiresAt && new Date(facts.expiresAt).getTime() <= now.getTime()) {
        paused = `The campaign page says it ended on ${facts.expiresAt.slice(0, 10)}.`;
      }
    }
    sources.recordCampaignCheck(p.id, now, paused, budgetLeftUsd);
    if (paused) return { ok: false, message: `${paused} The campaign is paused: no new streams or posts under it.` };
    return { ok: true, message: "The campaign is still running. Checked just now." };
  }

  /** Reads every running campaign whose page was last read a day or more ago, one after the other. */
  checkDue(): Promise<number> {
    const run = async () => {
      const before = new Date(this.now().getTime() - CAMPAIGN_RECHECK_HOURS * 3600_000);
      const due = this.deps.sources.campaignsCheckedBefore(before).filter((p) => isCampaignUrl(p.campaignUrl!));
      for (const p of due) await this.recheck(p);
      return due.length;
    };
    const next = this.running.then(run, run);
    this.running = next.catch(() => undefined);
    return next;
  }

  /** Looks for due campaigns every `intervalMs`; each still comes up once a day. */
  start(intervalMs: number): void {
    const tick = () => void this.checkDue().catch((err: unknown) => console.error("Campaign check failed:", err));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
