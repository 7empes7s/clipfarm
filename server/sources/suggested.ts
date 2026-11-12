import type { Platform, Source, SuggestedCreator, WatchChannel } from "../../shared/types.js";
import { channelUrl } from "../../shared/watchlist.js";
import { ValidationError } from "../errors.js";
import { parseNewSource, type SourcesRepo } from "./repo.js";
import { parseWatchedCreator, type WatchlistRepo } from "./watchlist/repo.js";

export type SeedCreator = Omit<SuggestedCreator, "added">;

/** Checks the starter list (server/sources/seed/public-allowance.json): every entry needs its proof. */
export function parseSuggested(seed: unknown[]): SeedCreator[] {
  return seed.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const watched = parseWatchedCreator({ name: e.name, channels: e.channels, language: e.language });
    const checkedOn = typeof e.checkedOn === "string" ? e.checkedOn : "";
    const { permission } = parseNewSource(newSourceBody({ ...e, name: watched.name, channels: watched.channels, checkedOn }));
    return {
      name: watched.name,
      channels: watched.channels,
      language: watched.language,
      proofUrl: permission.proofUrl!,
      proofQuote: permission.proofQuote!,
      checkedOn: permission.proofCheckedAt!.slice(0, 10),
      rules: permission.briefRules ?? "",
      allowedPlatforms: permission.allowedPlatforms,
      note: typeof e.note === "string" ? e.note.trim() : "",
    };
  });
}

function newSourceBody(e: { name?: unknown; channels?: unknown; proofUrl?: unknown; proofQuote?: unknown; checkedOn?: unknown; rules?: unknown; allowedPlatforms?: unknown }) {
  return {
    creatorName: e.name,
    channelUrls: (e.channels as WatchChannel[]).map(channelUrl),
    permission: {
      kind: "public-allowance",
      proofUrl: e.proofUrl,
      proofQuote: e.proofQuote,
      proofCheckedAt: e.checkedOn,
      briefRules: e.rules,
      allowedPlatforms: (e.allowedPlatforms as Platform[] | undefined) ?? ["tiktok", "youtube", "instagram", "x"],
    },
  };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function listSuggested(seed: SeedCreator[], sources: Source[]): SuggestedCreator[] {
  return seed.map((c) => ({
    ...c,
    added: sources.some((s) => sameName(s.creatorName, c.name) && s.permissions.some((p) => p.kind === "public-allowance")),
  }));
}

/**
 * Adds the chosen starter-list creators: a source with the public allowance and its proof, and a
 * watchlist entry with auto-ingest on, so their GTA VI streams come in through the usual gate.
 */
export function addSuggested(
  names: string[],
  seed: SeedCreator[],
  deps: { sources: SourcesRepo; watchlist?: WatchlistRepo; now: Date },
): Source[] {
  const chosen = names.map((n) => {
    const c = seed.find((x) => sameName(x.name, n));
    if (!c) throw new ValidationError(`"${n}" is not on the suggested list.`);
    return c;
  });
  if (chosen.length === 0) throw new ValidationError("Pick at least one creator to add.");
  const added: Source[] = [];
  for (const c of chosen) {
    const all = deps.sources.list();
    if (listSuggested([c], all)[0]!.added) continue;
    const input = parseNewSource(newSourceBody(c), deps.now);
    const existing = all.find((s) => sameName(s.creatorName, c.name));
    if (existing) deps.sources.addPermission(existing.id, input.permission);
    const source = existing ? deps.sources.get(existing.id) : deps.sources.create(input);
    added.push(source);
    if (!deps.watchlist) continue;
    const watched =
      deps.watchlist.list().find((w) => sameName(w.name, c.name)) ??
      deps.watchlist.create({
        name: c.name,
        channels: c.channels,
        language: c.language,
        games: ["GTA VI"],
        program: "public",
        programUrl: c.proofUrl,
        note: c.note || `Says clipping is allowed (proof read on ${c.checkedOn}).`,
        sourceId: source.id,
      });
    if (source.permissionState === "active") deps.watchlist.setAutoIngest(watched.id, true);
  }
  return added;
}
