import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { StreamerEntry } from "../../shared/catalog.js";
import { allowanceInput, campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import type { ChatClient } from "../pipeline/picks/llm.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { CAMPAIGN_SCHEMA, extractCampaign, fillWithChat, isCampaignUrl, isImportUrl } from "../sources/campaign/extract.js";
import { Campaigns } from "../sources/campaign/service.js";
import { FakeProofFetcher, type ProofPage } from "../sources/proof.js";
import { SourcesRepo } from "../sources/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { PROGRAMS, programOf, rankPrograms } from "./programs.js";
import { dueEntries, nextCheckAt, parseSeedStreamers, RegistryRepo, StreamerRegistry } from "./registry.js";
import seedFile from "./seed/streamers.json" with { type: "json" };

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/campaigns/${name}`, import.meta.url), "utf8");
const TJR = fixture("tjr-reach-brief.txt");
const DISCORD = fixture("discord-payroll-rules.txt");

describe("a campaign brief becomes machine rules", () => {
  it("reads TJR's brief: the AI ban, the #TJR tag, original only, the $5 cap, length, clips a day and the submit window", () => {
    const facts = extractCampaign(TJR);
    expect(facts.creatorName).toBe("TJR");
    expect(facts.cpmRateUsd).toBe(1);
    expect(facts.allowedPlatforms).toEqual(["tiktok", "youtube", "instagram"]);
    expect(facts.rules).toMatchObject({
      aiBanned: true,
      requiredTags: ["#TJR"],
      originalOnly: true,
      payoutCapUsd: 5,
      minSec: 15,
      maxSec: 60,
      maxClipsPerDay: 3,
      submitWithinMin: 30,
      bannedWords: ["gambling"],
    });
    // Each line that made a rule is kept for the manager's one review.
    expect(facts.briefRules).toContain("AI content is banned: one strike and you are out.");
    expect(facts.briefRules).toContain("Original content only. No reuploads of other clippers' videos.");
  });

  it("reads a pasted Discord payroll's rules", () => {
    const facts = extractCampaign(DISCORD);
    expect(facts).toMatchObject({ cpmRateUsd: 0.8, minViews: 5000, rules: { requiredTags: ["@streamerdemo"], originalOnly: true } });
    expect(facts.rules.aiBanned).toBeUndefined();
  });

  it("lets a chat model (Gemini or OpenAI) add the rules the words left out, but only ones the page talks about", async () => {
    const brief = "TJR clipping. Do not use artificial intelligence for edits. Payout is limited to 5 dollars per clip. Submit fast: you have 2 hours.";
    const answer = (o: Record<string, unknown>): ChatClient => ({
      name: "fake-chat",
      complete: () => Promise.resolve({ content: JSON.stringify({ ...Object.fromEntries(CAMPAIGN_SCHEMA.required.map((k) => [k, null])), ...o }), costUsd: 0 }),
    });
    const filled = await fillWithChat(extractCampaign(brief), brief, answer({ ai_banned: true, payout_cap_usd: 5, submit_within_minutes: 120, original_only: true, max_clips_per_day: 4 }));
    expect(filled.rules).toMatchObject({ aiBanned: true, payoutCapUsd: 5, submitWithinMin: 120 });
    // The page says nothing about original clips or clips a day: the model's guesses are dropped.
    expect(filled.rules.originalOnly).toBeFalsy();
    expect(filled.rules.maxClipsPerDay).toBeNull();
  });
});

describe("the program catalog", () => {
  it("knows each program's site, and imports links from all of them", () => {
    expect(programOf("https://whop.com/tjr/reach")).toBe("content-rewards");
    expect(programOf("https://www.vyro.com/campaigns/beast")).toBe("vyro");
    expect(programOf("https://clipping.net/c/123")).toBe("clipping-net");
    expect(programOf("https://discord.gg/abc123")).toBe("discord-payroll");
    expect(programOf("https://example.com/x")).toBeNull();
    expect(isImportUrl("https://discord.gg/abc123")).toBe(true);
    // A Discord server has no public page: it is never fetched.
    expect(isCampaignUrl("https://discord.gg/abc123")).toBe(false);
    expect(isImportUrl("http://vyro.com/x")).toBe(false);
  });

  it("lists pay per 1,000 views, cap, minimum, platforms, earning window, hold and a link for every program", () => {
    for (const p of PROGRAMS) {
      expect(p.url).toMatch(/^https:\/\//);
      expect(p.factsUrl).toMatch(/^https:\/\//);
      expect(p.platforms.length).toBeGreaterThan(0);
    }
    expect(PROGRAMS.find((p) => p.id === "content-rewards")).toMatchObject({ earningWindowDays: 7, holdDays: 3 });
    expect(PROGRAMS.find((p) => p.id === "vyro")).toMatchObject({ ratePer1kMinUsd: 3, capPerPostUsd: 1000, minViews: 1000, termsConfirmed: false });
  });

  it("ranks programs by expected dollars per clip: rate × our typical views, capped, times the chance of the minimum", () => {
    const start = rankPrograms(PROGRAMS, {});
    expect(start.map((p) => p.id)).toEqual(["vyro", "clipping-net", "content-rewards", "discord-payroll"]);
    // Clipping.net: $1.70 (the middle of $0.40–$3) × 2,500 + 1,500 + 1,200 starting views.
    expect(start.find((p) => p.id === "clipping-net")!.perClipUsd).toBeCloseTo((1.7 * 5200) / 1000, 2);
    // Vyro: $3 × views × the chance of reaching 1,000 views (2500/3500, 1500/2500, 1200/2200).
    expect(start[0]!.perClipUsd).toBeCloseTo(3 * (2.5 * (2500 / 3500) + 1.5 * (1500 / 2500) + 1.2 * (1200 / 2200)), 2);
    expect(start.at(-1)).toMatchObject({ perClipUsd: 0, estimateWhy: expect.stringContaining("No public rate") });

    // Our own posts never reach 1,000 views: Vyro pays nothing, and falls below the programs without a minimum.
    const small = Array.from({ length: 6 }, () => 800);
    const ours = rankPrograms(PROGRAMS, { tiktok: small, youtube: small, instagram: small });
    expect(ours.find((p) => p.id === "vyro")!.perClipUsd).toBe(0);
    expect(ours[0]!.id).toBe("clipping-net");

    // A cap per post holds the estimate down.
    const capped = rankPrograms([{ ...PROGRAMS[1]!, minViews: null, capPerPostUsd: 0.5, platforms: ["tiktok"] }], {});
    expect(capped[0]!.perClipUsd).toBe(0.5);
  });
});

function registrySetup(pages: Record<string, ProofPage> = {}, campaigns: Record<string, string[]> = {}) {
  let now = new Date("2026-11-14T12:00:00.000Z");
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const repo = new RegistryRepo(db);
  const fetcher = new FakeProofFetcher(pages);
  const registry = new StreamerRegistry({ repo, sources, fetcher, campaignsFor: (n) => campaigns[n] ?? [], now: clock });
  return { db, sources, repo, registry, setNow: (d: string) => (now = new Date(d)) };
}

const entry = (o: Partial<StreamerEntry>): StreamerEntry => ({
  name: "X",
  status: "program",
  program: null,
  proofUrl: null,
  proofQuote: null,
  checkedAt: "2026-11-01T00:00:00.000Z",
  nextCheckAt: "2026-11-08T00:00:00.000Z",
  lastResult: "",
  note: "",
  ...o,
});

describe("the streamer registry", () => {
  it("starts from a seed where every program has a proof link, and the creators without one are marked", () => {
    const seed = parseSeedStreamers(seedFile.streamers);
    const names = (status: string) => seed.filter((s) => s.status === status).map((s) => s.name);
    expect(names("program")).toEqual(expect.arrayContaining(["TJR", "IShowSpeed", "Lacy", "CORE", "JasonTheWeen", "N3on"]));
    expect(names("no-program")).toEqual(expect.arrayContaining(["Kai Cenat", "Adin Ross", "xQc"]));
    expect(() => parseSeedStreamers([{ name: "Y", status: "program", checkedOn: "2026-11-14" }])).toThrow("needs a public proof link");
  });

  it("checks each entry again 7 days after the last check, the most overdue first", () => {
    expect(nextCheckAt(new Date("2026-11-14T12:00:00.000Z"))).toBe("2026-11-21T12:00:00.000Z");
    const list = [entry({ name: "A", nextCheckAt: "2026-11-15T00:00:00.000Z" }), entry({ name: "B", nextCheckAt: "2026-11-10T00:00:00.000Z" }), entry({ name: "C", nextCheckAt: "2026-11-12T00:00:00.000Z" })];
    expect(dueEntries(list, new Date("2026-11-14T00:00:00.000Z")).map((e) => e.name)).toEqual(["B", "C"]);
  });

  it("re-checks due entries: proof still there, proof gone, a page that cannot be read (tried tomorrow), and a new program found", async () => {
    const { repo, registry, setNow } = registrySetup(
      { "https://ok.example/tjr": { status: 200, text: "<p>Clip TJR and get paid</p>" }, "https://down.example/x": { status: 503, text: "" } },
      { "Kai Cenat": ["https://contentrewards.com/c/campaigns/kai-demo"] },
    );
    repo.seed([
      { name: "TJR", status: "program", program: "Reach", proofUrl: "https://ok.example/tjr", proofQuote: "Clip TJR and get paid", checkedOn: "2026-11-01", note: "" },
      { name: "Lacy", status: "program", program: "Reach", proofUrl: "https://gone.example/lacy", proofQuote: null, checkedOn: "2026-11-01", note: "" },
      { name: "Down", status: "program", program: "Reach", proofUrl: "https://down.example/x", proofQuote: null, checkedOn: "2026-11-01", note: "" },
      { name: "Kai Cenat", status: "no-program", program: null, proofUrl: null, proofQuote: null, checkedOn: "2026-11-01", note: "" },
      { name: "xQc", status: "no-program", program: null, proofUrl: null, proofQuote: null, checkedOn: "2026-11-01", note: "" },
      { name: "Fresh", status: "no-program", program: null, proofUrl: null, proofQuote: null, checkedOn: "2026-11-13", note: "" },
    ]);
    expect(await registry.checkDue()).toBe(5);
    expect(repo.find("TJR")).toMatchObject({ status: "program", checkedAt: "2026-11-14T12:00:00.000Z", nextCheckAt: "2026-11-21T12:00:00.000Z" });
    expect(repo.find("Lacy")).toMatchObject({ status: "gone", lastResult: expect.stringContaining("404") });
    expect(repo.find("Down")).toMatchObject({ status: "program", checkedAt: "2026-11-01T00:00:00.000Z", nextCheckAt: "2026-11-15T12:00:00.000Z" });
    expect(repo.find("Kai Cenat")).toMatchObject({ status: "program", proofUrl: "https://contentrewards.com/c/campaigns/kai-demo" });
    expect(repo.find("xQc")).toMatchObject({ status: "no-program", lastResult: "Still no clipping program found." });
    // Checked a day ago: not due.
    expect(repo.find("Fresh")!.checkedAt).toBe("2026-11-13T00:00:00.000Z");
    expect(await registry.checkDue()).toBe(0);
    setNow("2026-11-15T13:00:00.000Z");
    expect(await registry.checkDue()).toBe(1);
  });

  it("never lets a creator without a program post to main accounts: a public allowance is refused, or put on hold", async () => {
    const { db, sources, repo, registry } = registrySetup();
    repo.seed([{ name: "Kai Cenat", status: "no-program", program: null, proofUrl: null, proofQuote: null, checkedOn: "2026-11-14", note: "" }]);
    const held = sources.create(allowanceInput({}));
    const named = sources.create({ ...allowanceInput({}), creatorName: "kai cenat" });
    expect(registry.enforce()).toBe(1);
    expect(sources.get(named.id).permissionState).toBe("needs-review");
    expect(sources.get(held.id).permissionState).toBe("active");

    expect(registry.blockReason("Kai Cenat", "public-allowance")).toContain("has no public clipping program");
    expect(registry.blockReason("Kai Cenat", "experiment")).toBeNull();
    expect(registry.blockReason("Kai Cenat", "direct-permission")).toBeNull();

    const clock = () => new Date("2026-11-14T12:00:00.000Z");
    const posts = new PostsRepo(db, clock);
    const clips = new ClipsRepo(db, clock);
    const queue = new JobQueue(db, { handlers: {} });
    queue.stop();
    const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService(), now: clock });
    const app = createApp({ sources, vods: new VodsRepo(db, clock), picks: new PicksRepo(db), queue, clips, posts, publisher, registry });
    const res = await request(app).post("/api/sources").send({ ...allowanceInput({}), creatorName: "Kai Cenat" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Kai Cenat has no public clipping program");
    // Importing a real campaign for them is proof of a program.
    expect((await request(app).post("/api/campaigns").send({ ...campaignInput(), creatorName: "Kai Cenat" })).status).toBe(201);
    expect(repo.find("Kai Cenat")).toMatchObject({ status: "program", proofUrl: "https://whop.com/test/campaign" });
    expect((await request(app).get("/api/catalog")).body).toMatchObject({ programs: expect.any(Array), streamers: [expect.objectContaining({ name: "Kai Cenat" })] });
  });
});

describe("importing from the other programs", () => {
  function campaigns(pages: Record<string, ProofPage>) {
    const db = openDb(":memory:");
    return new Campaigns({ sources: new SourcesRepo(db), fetcher: new FakeProofFetcher(pages) });
  }

  it("reads a Vyro campaign page and names its program", async () => {
    const url = "https://vyro.com/campaigns/beast-demo";
    const draft = await campaigns({ [url]: { status: 200, text: "<h1>Beast demo</h1><p>Creator: Beast Demo</p><p>$3 per 1,000 views</p><p>$1,000 max per post</p>" } }).read(url);
    expect(draft).toMatchObject({ creatorName: "Beast Demo", cpmRateUsd: 3, rules: { program: "vyro", payoutCapUsd: 1000 } });
  });

  it("asks for a Discord payroll's rules to be pasted, and reads them when they are", async () => {
    const c = campaigns({});
    await expect(c.read("https://discord.gg/demo")).rejects.toThrow("a Discord server has no public page");
    const draft = await c.read("https://discord.gg/demo", DISCORD);
    expect(draft).toMatchObject({ cpmRateUsd: 0.8, rules: { program: "discord-payroll", requiredTags: ["@streamerdemo"] } });
  });
});
