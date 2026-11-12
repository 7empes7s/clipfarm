import { describe, expect, it } from "vitest";
import { stepTable } from "../e2e/live/report.js";
import { assertMayPost, liveSettings } from "../e2e/live/settings.js";

const LIVE = "https://clip.techinsiderbytes.com";
const VIDEO = { E2E_VIDEO_URL: "https://example.com/our-own-test-video" };

describe("live-safe settings for npm run e2e:live", () => {
  it("is a dry run unless told otherwise, on any address", () => {
    expect(liveSettings({ BASE_URL: "http://localhost:5426" })).toMatchObject({ baseUrl: "http://localhost:5426", local: true, dryRun: true });
    expect(liveSettings({ BASE_URL: LIVE, ...VIDEO })).toMatchObject({ baseUrl: LIVE, local: false, dryRun: true });
  });

  it("refuses a non-local address without the dry run", () => {
    expect(() => liveSettings({ BASE_URL: LIVE, ...VIDEO, E2E_DRY_RUN: "0" })).toThrow(
      "Refusing to run against https://clip.techinsiderbytes.com without the dry run: real posting is only tried on a local preview. Remove E2E_DRY_RUN=0.",
    );
    for (const url of ["http://10.0.0.5:3000", "https://localhost.example.com", "http://127.0.0.1.nip.io"]) {
      expect(() => liveSettings({ BASE_URL: url, ...VIDEO, E2E_DRY_RUN: "0" }), url).toThrow(/^Refusing to run against/);
    }
  });

  it("lets a local preview post for real, and only through the test posting service", () => {
    for (const url of ["http://localhost:5426", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      const s = liveSettings({ BASE_URL: url, E2E_DRY_RUN: "0" });
      expect(s, url).toMatchObject({ local: true, dryRun: false });
      expect(() => assertMayPost(s, "fake")).not.toThrow();
      expect(() => assertMayPost(s, "postiz")).toThrow("Refusing to post: this server posts through postiz, a real posting service.");
    }
  });

  it("never posts in a dry run, whatever the server's posting service", () => {
    const s = liveSettings({ BASE_URL: LIVE, ...VIDEO });
    for (const service of ["fake", "postiz", "upload-post", "none"]) {
      expect(() => assertMayPost(s, service), service).toThrow("Refusing to post: this is a dry run.");
    }
  });

  it("needs a named test video on a non-local address, and never guesses one", () => {
    expect(() => liveSettings({ BASE_URL: LIVE })).toThrow(/Set E2E_VIDEO_URL/);
    expect(() => liveSettings({ BASE_URL: LIVE, E2E_VIDEO_URL: "not a link" })).toThrow(/E2E_VIDEO_URL is not a web link/);
    expect(liveSettings({ BASE_URL: "http://localhost:5426" }).videoUrl).toMatch(/^https:\/\/example\.com\//);
  });

  it("sends the Cloudflare Access service token only as a pair and only over https", () => {
    const token = { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "secret" };
    expect(liveSettings({ BASE_URL: LIVE, ...VIDEO, ...token }).headers).toEqual({
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "secret",
    });
    expect(liveSettings({ BASE_URL: LIVE, ...VIDEO }).headers).toEqual({});
    expect(() => liveSettings({ BASE_URL: LIVE, ...VIDEO, CF_ACCESS_CLIENT_ID: "id.access" })).toThrow(/both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET/);
    expect(() => liveSettings({ BASE_URL: "http://clip.example.com", ...VIDEO, ...token })).toThrow(/only sent over https/);
  });

  it("refuses an address that is not a web link", () => {
    expect(() => liveSettings({ BASE_URL: "clip.techinsiderbytes.com" })).toThrow(/BASE_URL is not a web link/);
    expect(() => liveSettings({})).toThrow(/Set BASE_URL/);
  });

  it("allows the 30-minute goal on a live site and less on a local preview", () => {
    expect(liveSettings({ BASE_URL: LIVE, ...VIDEO }).pipelineTimeoutMs).toBe(30 * 60_000);
    expect(liveSettings({ BASE_URL: "http://localhost:5426" }).pipelineTimeoutMs).toBe(5 * 60_000);
    expect(liveSettings({ BASE_URL: LIVE, ...VIDEO, E2E_PIPELINE_MINUTES: "45" }).pipelineTimeoutMs).toBe(45 * 60_000);
  });
});

describe("the pass/fail table", () => {
  it("lists each step per screen with its time, and the link-to-clips time against the 30-minute goal", () => {
    const table = stepTable({
      target: "http://localhost:5426 (dry run)",
      projects: ["phone", "desktop"],
      rows: [
        { step: "The gallery loads", project: "phone", status: "passed", ms: 1234 },
        { step: "The gallery loads", project: "desktop", status: "passed", ms: 900 },
        { step: "A link becomes clips", project: "phone", status: "failed", ms: 95_000 },
        { step: "A link becomes clips", project: "desktop", status: "skipped", ms: 0 },
      ],
      linkToClipsMs: { phone: 95_000 },
    });
    expect(table).toBe(
      [
        "clipfarm end to end: http://localhost:5426 (dry run)",
        "",
        "| Step                 | phone       | desktop    |",
        "|----------------------|-------------|------------|",
        "| The gallery loads    | pass 1.2 s  | pass 0.9 s |",
        "| A link becomes clips | FAIL 1m 35s | not run    |",
        "",
        "Link to clips (goal: under 30 min): phone 1m 35s, within the goal",
        "Result: FAIL (1 step failed, 1 not run)",
      ].join("\n"),
    );
  });

  it("says when the link-to-clips step went over the goal, and passes when every step passed", () => {
    const table = stepTable({
      target: "x",
      projects: ["phone"],
      rows: [{ step: "A link becomes clips", project: "phone", status: "passed", ms: 31 * 60_000 }],
      linkToClipsMs: { phone: 31 * 60_000 },
    });
    expect(table).toContain("Link to clips (goal: under 30 min): phone 31m 0s, OVER the goal");
    expect(table).toContain("Result: PASS");
  });
});
