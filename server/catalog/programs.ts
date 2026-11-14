import type { Program, ProgramId, ProgramListing } from "../../shared/catalog.js";
import { type ScoreContext, platformEarnings } from "../scout/score.js";

/**
 * The clipping programs that pay for clips, with the terms public pages report. Numbers that come
 * from reports and not from the program itself are marked unconfirmed. Edit freely as terms change.
 */
export const PROGRAMS: Program[] = [
  {
    id: "content-rewards",
    name: "Content Rewards (Whop)",
    url: "https://contentrewards.com/c/discover/clipping",
    hosts: ["contentrewards.com", "whop.com", "reachclipping.com"],
    ratePer1kMinUsd: 1.09,
    ratePer1kMaxUsd: 1.09,
    capPerPostUsd: null,
    minViews: null,
    platforms: ["tiktok", "youtube", "instagram", "x"],
    earningWindowDays: 7,
    holdDays: 3,
    import: "scout",
    termsConfirmed: false,
    factsUrl: "https://contentrewards.com/articles/how-to-choose-a-clipping-platform",
    checkedOn: "2026-11-14",
    note: "About 700 live campaigns; $1.09 per 1,000 views is the middle rate. Each campaign sets its own cap and minimum. A post earns for 7 days, then the money is held 3 days. The brand approves each clip. The scout reads the campaigns every day.",
  },
  {
    id: "vyro",
    name: "Vyro (MrBeast)",
    url: "https://vyro.com",
    hosts: ["vyro.com"],
    ratePer1kMinUsd: 3,
    ratePer1kMaxUsd: 3,
    capPerPostUsd: 1000,
    minViews: 1000,
    platforms: ["tiktok", "youtube", "instagram"],
    earningWindowDays: null,
    holdDays: null,
    import: "paste-link",
    termsConfirmed: false,
    factsUrl: "https://www.opus.pro/blog/mrbeasts-vyro",
    checkedOn: "2026-11-14",
    note: "Reported, not confirmed by Vyro: $3 per 1,000 views, $1,000 at most per post, paid from 1,000 views. Sign up there, then paste a campaign link (or its text) to import it.",
  },
  {
    id: "clipping-net",
    name: "Clipping.net",
    url: "https://clipping.net",
    hosts: ["clipping.net"],
    ratePer1kMinUsd: 0.4,
    ratePer1kMaxUsd: 3,
    capPerPostUsd: null,
    minViews: null,
    platforms: ["tiktok", "youtube", "instagram"],
    earningWindowDays: null,
    holdDays: null,
    import: "paste-link",
    termsConfirmed: false,
    factsUrl: "https://www.clipaffiliates.com/blog/clipping-net-review",
    checkedOn: "2026-11-14",
    note: "Reported: $0.40 to $3 per 1,000 views, usually with a view minimum per campaign. Paste a campaign link (or its text) to import it.",
  },
  {
    id: "discord-payroll",
    name: "Discord payroll programs",
    url: "https://discord.com",
    hosts: ["discord.gg", "discord.com"],
    ratePer1kMinUsd: null,
    ratePer1kMaxUsd: null,
    capPerPostUsd: null,
    minViews: null,
    platforms: ["tiktok", "youtube", "instagram"],
    earningWindowDays: null,
    holdDays: null,
    import: "paste-text",
    termsConfirmed: false,
    factsUrl: "https://ground.news/article/kick-gambling-streamer-n3on-is-spending-millions-on-his-army-of-clippers",
    checkedOn: "2026-11-14",
    note: "Streamers like N3on pay clippers from their own Discord server. There is no public page to read: paste the invite link and the server's rules text, and clipfarm turns it into rules.",
  },
];

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The program a campaign link belongs to, by its site; null for any other site. */
export function programOf(rawUrl: string, programs: Program[] = PROGRAMS): ProgramId | null {
  const host = hostOf(rawUrl);
  if (!host) return null;
  return programs.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)))?.id ?? null;
}

function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Every program with what one of our clips should earn on it: the middle of its reported rate times
 * our typical views per platform, capped per post, times the chance of reaching its minimum. Best first;
 * a program with no reported rate comes last with $0 and says why.
 */
export function rankPrograms(programs: Program[], ourViews: ScoreContext["ourViews"]): ProgramListing[] {
  return programs
    .map((p): ProgramListing => {
      if (p.ratePer1kMinUsd === null) return { ...p, perClipUsd: 0, estimateWhy: "No public rate: each server sets its own. Paste its rules to see them." };
      const rate = (p.ratePer1kMinUsd + (p.ratePer1kMaxUsd ?? p.ratePer1kMinUsd)) / 2;
      const { perClip, steps } = platformEarnings(rate, p.platforms, p.minViews ?? 0, p.capPerPostUsd, ourViews);
      return {
        ...p,
        perClipUsd: Math.round(perClip * 100) / 100,
        estimateWhy: `${steps.map((s) => `${s.label}: ${s.value}`).join(", ")}, from ${dollars(rate)} per 1,000 views.`,
      };
    })
    .sort((a, b) => b.perClipUsd - a.perClipUsd || a.name.localeCompare(b.name));
}
