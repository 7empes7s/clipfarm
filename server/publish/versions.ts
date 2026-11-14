import type { CampaignRules, Platform } from "../../shared/types.js";
import { PLATFORM_LABELS } from "../../shared/types.js";
import { PLATFORM_RULES, type PostVersion } from "../../shared/publishing.js";
import { ValidationError } from "../errors.js";
import { briefRequirements } from "./caption.js";
import { says } from "./compliance.js";

/** What a clip's version on one platform is made from. */
export interface VersionContext {
  title: string;
  creatorName: string;
  channelUrl: string | null;
  briefRules: string;
  rules: CampaignRules | null;
  platform: Platform;
}

export type VersionFields = Pick<PostVersion, "title" | "caption" | "hashtags" | "coverId">;

const HASHTAG = /^#[\p{L}\p{N}_]+$/u;

function unique(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cut(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** What the campaign requires in every caption: its hashtags, links and words. */
export function requirements(ctx: VersionContext): { tags: string[]; links: string[]; text: string[] } {
  const brief = briefRequirements(ctx.briefRules);
  return {
    tags: unique([...brief.hashtags, ...(ctx.rules?.requiredTags ?? [])]),
    links: [...new Set([...brief.links, ...(ctx.rules?.requiredLinks ?? [])])],
    text: ctx.rules?.requiredText ?? [],
  };
}

/** The caption as it goes out: the text, a blank line, then the hashtags. */
export function composeCaption(v: Pick<PostVersion, "caption" | "hashtags">): string {
  const tags = v.hashtags.join(" ");
  return tags ? `${v.caption.trimEnd()}\n\n${tags}` : v.caption.trimEnd();
}

/**
 * The version a clip starts with on a platform: its title (cut to the platform's title limit), then
 * a caption of title, credit, required words and links, with the campaign's tags as hashtags. When
 * the caption limit is tight (X, Bluesky, Threads), only the title line is shortened.
 */
export function defaultVersion(ctx: VersionContext): VersionFields {
  const rule = PLATFORM_RULES[ctx.platform];
  const req = requirements(ctx);
  const required = [
    ctx.channelUrl ? `Credit: ${ctx.creatorName} ${ctx.channelUrl}` : `Credit: ${ctx.creatorName}`,
    ...req.text,
    ...req.links.filter((l) => l !== ctx.channelUrl),
  ].join("\n");
  const tagsLength = req.tags.length > 0 ? req.tags.join(" ").length + 2 : 0;
  const room = rule.captionMax - required.length - 2 - tagsLength;
  return {
    title: cut(ctx.title, rule.titleMax),
    caption: `${cut(ctx.title, room)}\n\n${required}`,
    hashtags: req.tags,
    coverId: null,
  };
}

/** What keeps a version from going out, in plain words; empty when it can. */
export function versionProblems(v: VersionFields, ctx: VersionContext): string[] {
  const rule = PLATFORM_RULES[ctx.platform];
  const label = PLATFORM_LABELS[ctx.platform];
  const req = requirements(ctx);
  const problems: string[] = [];
  const title = v.title.trim();
  if (!title) problems.push("Give it a title.");
  if (title.length > rule.titleMax) problems.push(`The title is ${title.length} characters; ${label} takes ${rule.titleMax}.`);
  const full = composeCaption(v);
  if (full.length > rule.captionMax) problems.push(`The caption is ${full.length} characters with hashtags; ${label} takes ${rule.captionMax}.`);
  for (const tag of v.hashtags) if (!HASHTAG.test(tag)) problems.push(`“${tag}” is not a hashtag: start it with # and use letters, numbers or _.`);
  const tagged = new Set(v.hashtags.map((t) => t.toLowerCase()));
  for (const tag of req.tags) if (!tagged.has(tag.toLowerCase()) && !says(v.caption, tag)) problems.push(`The campaign requires ${tag}.`);
  for (const link of req.links) if (!full.toLowerCase().includes(link.toLowerCase())) problems.push(`The campaign requires the link ${link}.`);
  for (const text of req.text) if (!full.toLowerCase().includes(text.toLowerCase())) problems.push(`The campaign requires the words “${text}”.`);
  if (!v.caption.toLowerCase().includes(ctx.creatorName.toLowerCase())) problems.push(`The caption must credit ${ctx.creatorName}.`);
  const max = Math.max(rule.hashtagsMax, req.tags.length);
  if (v.hashtags.length > max) problems.push(`${label} takes ${max} hashtags at most without looking spammy; this has ${v.hashtags.length}.`);
  return problems;
}

/** A version as the sheet sends it; hashtags may be one string split on spaces and commas. */
export function parseVersion(body: unknown): VersionFields {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.title !== "string") throw new ValidationError("The title must be text.");
  if (typeof b.caption !== "string") throw new ValidationError("The caption must be text.");
  const raw = typeof b.hashtags === "string" ? b.hashtags.split(/[\s,]+/) : Array.isArray(b.hashtags) ? b.hashtags.map(String) : [];
  const coverId = b.coverId === null || b.coverId === undefined ? null : Number(b.coverId);
  if (coverId !== null && !Number.isInteger(coverId)) throw new ValidationError("Pick a cover from the list.");
  return { title: b.title.trim(), caption: b.caption.trim(), hashtags: unique(raw.map((t) => t.trim()).filter(Boolean)), coverId };
}
