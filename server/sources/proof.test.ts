import request from "supertest";
import { describe, expect, it } from "vitest";
import { allowanceInput, campaignInput } from "../../test/helpers.js";
import { createApp } from "../app.js";
import { ClipsRepo } from "../clips/repo.js";
import { openDb } from "../db/index.js";
import { JobQueue } from "../jobs/queue.js";
import { PicksRepo } from "../picks/repo.js";
import { FakePostingService } from "../publish/fake.js";
import { Publisher } from "../publish/publisher.js";
import { PostsRepo } from "../publish/repo.js";
import { VodsRepo } from "../vods/repo.js";
import { AllowanceChecker, FakeProofFetcher, findAllowanceQuote, HttpProofFetcher, isPublicWebUrl, judgeProof, pageText } from "./proof.js";
import { SourcesRepo } from "./repo.js";

const PROOF = "https://openstreamer.example/clips";
const QUOTE = "You can clip my streams and post them anywhere";
const SAYS_IT = `<html><body><h2>Clips</h2><p>You can <b>clip</b> my streams &amp; VODs.\n   You can clip my   streams and post them anywhere, just credit me.</p></body></html>`;

/** A fetch that answers from a table and counts the calls: no network. */
function fakeFetch(pages: Record<string, { status: number; body: string; location?: string } | Error>) {
  const calls: string[] = [];
  const doFetch = ((url: string) => {
    calls.push(url);
    const page = pages[url] ?? { status: 404, body: "Not found" };
    if (page instanceof Error) return Promise.reject(page);
    return Promise.resolve(new Response(page.body || null, { status: page.status, headers: page.location ? { location: page.location } : {} }));
  }) as typeof fetch;
  return { doFetch, calls };
}

function setup(pages: Parameters<typeof fakeFetch>[0]) {
  let now = new Date("2026-11-12T12:00:00Z");
  const clock = () => now;
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db, clock);
  const { doFetch, calls } = fakeFetch(pages);
  const checker = new AllowanceChecker({ sources, fetcher: new HttpProofFetcher(doFetch), now: clock });
  const source = sources.create(allowanceInput());
  const queue = new JobQueue(db, { handlers: { ingest: async () => {} } });
  queue.stop();
  const clips = new ClipsRepo(db, clock);
  const posts = new PostsRepo(db, clock);
  const publisher = new Publisher({ sources, clips, posts, service: new FakePostingService(), now: clock });
  const app = createApp({ sources, vods: new VodsRepo(db, clock), picks: new PicksRepo(db), queue, clips, posts, publisher, allowance: checker });
  return { sources, checker, source, permissionId: source.permissions[0]!.id, calls, app, setNow: (d: string) => (now = new Date(d)) };
}

describe("pageText / judgeProof", () => {
  it("finds a quote whatever the tags, entities, spacing, quote marks and case", () => {
    expect(pageText("<p>Don&#39;t worry:\n you&nbsp;can “CLIP” it</p>")).toBe(`don't worry: you can "clip" it`);
    expect(judgeProof({ status: 200, text: SAYS_IT }, QUOTE)).toEqual({ ok: true });
    expect(judgeProof({ status: 200, text: `{"bio":"Clippers welcome \\u0026 loved.\\nYou can clip my streams and post them anywhere"}` }, QUOTE)).toEqual({ ok: true });
  });

  it("says the proof is gone on a 404 or when the words are missing, and only that it could not look otherwise", () => {
    expect(judgeProof({ status: 404, text: "" }, QUOTE)).toMatchObject({ ok: false, gone: true });
    expect(judgeProof({ status: 200, text: "<p>No reuploads of my streams.</p>" }, QUOTE)).toEqual({
      ok: false,
      gone: true,
      reason: `The page no longer says "${QUOTE}".`,
    });
    expect(judgeProof({ status: 503, text: "" }, QUOTE)).toMatchObject({ ok: false, gone: false });
    expect(judgeProof({ status: 403, text: QUOTE }, QUOTE)).toMatchObject({ ok: false, gone: false });
  });
});

describe("re-checking a public allowance (faked fetch)", () => {
  it("stays active when the page still says it, and runs 90 days from the new check", async () => {
    const { checker, sources, source, permissionId, calls } = setup({ [PROOF]: { status: 200, body: SAYS_IT } });
    expect(await checker.check(permissionId)).toEqual({ ok: true, message: "The page still says it. Checked just now." });
    expect(calls).toEqual([PROOF]);
    const after = sources.get(source.id);
    expect(after.permissionState).toBe("active");
    expect(after.permissions[0]).toMatchObject({
      proofCheckedAt: "2026-11-12T12:00:00.000Z",
      expiresAt: "2027-02-10T12:00:00.000Z",
      reviewReason: null,
    });
  });

  it("needs review when the words are gone, which stops new links", async () => {
    const { checker, sources, source, permissionId, app } = setup({ [PROOF]: { status: 200, body: "<p>Clips are for members only now.</p>" } });
    const result = await checker.check(permissionId);
    expect(result).toEqual({ ok: false, message: `The page no longer says "${QUOTE}".` });
    expect(sources.get(source.id)).toMatchObject({ permissionState: "needs-review", permissions: [{ reviewReason: result.message }] });
    const res = await request(app).post("/api/vods").send({ sourceId: source.id, url: "https://kick.com/openstreamer/videos/1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("needs review: The page no longer says");
  });

  it("needs review when the page is gone (404)", async () => {
    const { checker, sources, source, permissionId } = setup({});
    expect((await checker.check(permissionId)).message).toBe('The page with their words is gone (it answers "404 not found").');
    expect(sources.get(source.id).permissionState).toBe("needs-review");
  });

  it("changes nothing when the page cannot be read this time (server error, network down)", async () => {
    for (const page of [{ status: 500, body: "" }, new Error("fetch failed")]) {
      const { checker, sources, source, permissionId } = setup({ [PROOF]: page });
      const result = await checker.check(permissionId);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Nothing was changed; try again later\.$/);
      expect(sources.get(source.id)).toMatchObject({ permissionState: "active", permissions: [{ proofCheckedAt: "2026-11-10T00:00:00.000Z" }] });
    }
  });

  it("\"Check again\" brings a held allowance back once the page says it again", async () => {
    const { sources, source, permissionId, app } = setup({ [PROOF]: { status: 200, body: SAYS_IT } });
    sources.flagForReview(permissionId, "The page with their words is gone.");
    const res = await request(app).post(`/api/permissions/${permissionId}/check`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, source: { id: source.id, permissionState: "active" } });
  });

  it("\"Check again\" is only for public allowances", async () => {
    const { sources, app, calls } = setup({});
    const whop = sources.create(campaignInput());
    const res = await request(app).post(`/api/permissions/${whop.permissions[0]!.id}/check`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Only a public clipping allowance has a proof page to check.");
    expect(calls).toEqual([]);
  });

  it("the weekly check reads only proofs last seen a week or more ago, and skips ones already held", async () => {
    const other = "https://second.example/about";
    const { checker, sources, source, calls, setNow } = setup({ [PROOF]: { status: 200, body: SAYS_IT } });
    const second = sources.create({ ...allowanceInput({ proofUrl: other, proofCheckedAt: "2026-11-04" }), creatorName: "Second" });
    sources.create(campaignInput());

    // 12 Nov: the first was read 2 days ago, the second 8 days ago. Its page is gone.
    expect(await checker.checkDue()).toBe(1);
    expect(calls).toEqual([other]);
    expect(sources.get(second.id).permissionState).toBe("needs-review");
    expect(sources.get(source.id).permissionState).toBe("active");

    // A week after the first was read: it is due, the held one is left for the manager.
    setNow("2026-11-17T12:00:00Z");
    expect(await checker.checkDue()).toBe(1);
    expect(calls).toEqual([other, PROOF]);
    expect(sources.get(source.id).permissions[0]!.proofCheckedAt).toBe("2026-11-17T12:00:00.000Z");
    expect(await checker.checkDue()).toBe(0);
  });

  it("never fetches a link into the server's own network", async () => {
    for (const bad of ["http://localhost:3000/x", "http://127.0.0.1/x", "http://192.168.1.4/", "http://10.0.0.1/", "https://[::1]/", "ftp://example.com/x", "http://intranet/"]) {
      expect(isPublicWebUrl(bad), bad).toBe(false);
    }
    expect(isPublicWebUrl(PROOF)).toBe(true);
    const { checker, sources, source, calls } = setup({});
    const local = sources.create({ ...allowanceInput({ proofUrl: "http://127.0.0.1:3600/admin" }), creatorName: "Local" });
    const result = await checker.check(local.permissions[0]!.id);
    expect(result).toEqual({ ok: false, message: "The proof link is not a public web page, so it cannot be checked." });
    expect(calls).toEqual([]);
    expect(sources.get(source.id).permissionState).toBe("active");
  });
});

describe("redirects", () => {
  it("follows a redirect to another public page, never one into the server's own network", async () => {
    const moved = "https://openstreamer.example/clipping-rules";
    const { checker, sources, source, permissionId, calls } = setup({
      [PROOF]: { status: 301, body: "", location: "/clipping-rules" },
      [moved]: { status: 200, body: SAYS_IT },
      "https://sneaky.example/panel": { status: 302, body: "", location: "http://127.0.0.1:3600/admin" },
    });
    expect((await checker.check(permissionId)).ok).toBe(true);
    expect(calls).toEqual([PROOF, moved]);

    const sneaky = sources.create({ ...allowanceInput({ proofUrl: "https://sneaky.example/panel" }), creatorName: "Sneaky" });
    const result = await checker.check(sneaky.permissions[0]!.id);
    expect(result.message).toBe(
      "The page could not be reached (it redirects to an address that is not a public web page). Nothing was changed; try again later.",
    );
    expect(calls).toEqual([PROOF, moved, "https://sneaky.example/panel"]);
    expect(sources.get(source.id).permissionState).toBe("active");
  });
});

describe("looking for a clipping allowance on a creator's page", () => {
  it("picks the sentence that clearly allows clipping", () => {
    expect(findAllowanceQuote("<div><h3>About</h3><p>Variety streamer. Feel free to clip and upload my streams, just credit me!</p></div>")).toBe(
      "Feel free to clip and upload my streams, just credit me!",
    );
    expect(findAllowanceQuote(`{"bio":"GTA RP every night. Clipping is allowed and encouraged."}`)).toBe("Clipping is allowed and encouraged.");
    expect(findAllowanceQuote("Join my clipping program on Whop and get paid per view")).toBe("Join my clipping program on Whop and get paid per view");
  });

  it("passes over pages that say nothing clear, or forbid it", () => {
    expect(findAllowanceQuote("<p>Streams every day at 6. Business: mail the team.</p>")).toBeNull();
    expect(findAllowanceQuote("<p>You may not upload my streams. Clipping is not allowed without permission.</p>")).toBeNull();
    expect(findAllowanceQuote("<p>Check my best clips on YouTube.</p>")).toBeNull();
  });

  it("offers the proof from the creator's own channel page, or says what it could not read", async () => {
    const db = openDb(":memory:");
    const sources = new SourcesRepo(db);
    const fetcher = new FakeProofFetcher({
      "https://www.twitch.tv/quiet/about": { status: 200, text: "<p>Streams every day.</p>" },
      "https://kick.com/api/v2/channels/openstreamer": { status: 200, text: `{"user":{"bio":"GTA RP. Anyone can clip my streams, credit the channel."}}` },
      "https://www.youtube.com/@blocked/about": { status: 403, text: "" },
    });
    const checker = new AllowanceChecker({ sources, fetcher, now: () => new Date("2026-11-12T12:00:00Z") });
    expect(await checker.find([{ platform: "twitch", handle: "quiet" }, { platform: "kick", handle: "OpenStreamer" }])).toEqual({
      found: {
        proofUrl: "https://kick.com/api/v2/channels/openstreamer",
        proofQuote: "Anyone can clip my streams, credit the channel.",
        checkedAt: "2026-11-12T12:00:00.000Z",
      },
      note: "Found on their page.",
    });
    expect((await checker.find([{ platform: "twitch", handle: "quiet" }])).found).toBeNull();
    const blocked = await checker.find([{ platform: "youtube", handle: "blocked" }]);
    expect(blocked.found).toBeNull();
    expect(blocked.note).toContain("Could not read https://www.youtube.com/@blocked.");
  });
});
