import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAccess } from "../test/accessToken.js";
import { type AccessVerifier, PUBLIC_PAGE_PATHS } from "./access.js";
import { createApp } from "./app.js";
import { ClipsRepo } from "./clips/repo.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { JobQueue } from "./jobs/queue.js";
import { PicksRepo } from "./picks/repo.js";
import {
  GOOGLE_PERMISSIONS_URL,
  GOOGLE_PRIVACY_URL,
  LIMITED_USE_SENTENCE,
  parseSupportEmail,
  USER_DATA_POLICY_URL,
  YOUTUBE_TERMS_URL,
} from "./publicPages.js";
import { FakePostingService } from "./publish/fake.js";
import { Publisher } from "./publish/publisher.js";
import { PostsRepo } from "./publish/repo.js";
import { SourcesRepo } from "./sources/repo.js";
import { VodsRepo } from "./vods/repo.js";

const SHELL = "<!doctype html><title>clipfarm</title><div id=root></div>";
const EMAIL = "help@clips.example";
let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** The built app (so the catch-all is there), with the sign-in gate when `access` is given. */
async function appFor(supportEmail: string | null, access?: AccessVerifier) {
  tmp = await mkdtemp(join(tmpdir(), "clipfarm-public-"));
  await writeFile(join(tmp, "index.html"), SHELL);
  const db = openDb(":memory:");
  const sources = new SourcesRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  return createApp({
    sources,
    vods: new VodsRepo(db),
    picks: new PicksRepo(db),
    queue: new JobQueue(db, { handlers: {} }),
    clips,
    posts,
    publisher: new Publisher({ sources, clips, posts, service: new FakePostingService() }),
    clientDir: tmp,
    supportEmail,
    access,
  });
}

describe("public pages (/home, /privacy, /terms)", () => {
  it("answers each with its own HTML, not the app shell, to a visitor who is not signed in", async () => {
    const app = await appFor(EMAIL, fakeAccess().verifier);
    for (const path of PUBLIC_PAGE_PATHS) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/html/);
      expect(res.headers.location).toBeUndefined();
      expect(res.text).not.toBe(SHELL);
      expect(res.text).toMatch(/<title>TechInsiderBytes[<:]/);
      expect(res.text).toContain(`mailto:${EMAIL}`);
      // Linked from each other.
      for (const other of PUBLIC_PAGE_PATHS) expect(res.text).toContain(`href="${other}"`);
      // The text is in the HTML itself: nothing runs, nothing is loaded, no cookie is set.
      expect(res.text).not.toMatch(/<script|<link|<img|<iframe|src=|@import|url\(/i);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.text).not.toMatch(/lorem|todo|tbd|placeholder/i);
    }
  });

  it("puts what Google and YouTube ask for in the Privacy Policy's HTML", async () => {
    const { text } = await request(await appFor(EMAIL)).get("/privacy");
    expect(LIMITED_USE_SENTENCE).toBe(
      "TechInsiderBytes' use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
    );
    expect(text).toContain(LIMITED_USE_SENTENCE);
    expect(USER_DATA_POLICY_URL).toBe("https://developers.google.com/terms/api-services-user-data-policy");
    expect(YOUTUBE_TERMS_URL).toBe("https://www.youtube.com/t/terms");
    expect(GOOGLE_PRIVACY_URL).toBe("https://policies.google.com/privacy");
    expect(GOOGLE_PERMISSIONS_URL).toBe("https://myaccount.google.com/permissions");
    for (const url of [USER_DATA_POLICY_URL, YOUTUBE_TERMS_URL, GOOGLE_PRIVACY_URL, GOOGLE_PERMISSIONS_URL]) {
      expect(text).toContain(`href="${url}"`);
    }
    expect(text).toContain("uses YouTube API Services");
    expect(text).toMatch(/Effective \d{1,2} \w+ 20\d\d/);
    expect(text).toMatch(/delete[^.]* within 7 days/);
    expect(text).toMatch(/no cookies/);
  });

  it("says in the Terms that users of the YouTube features agree to the YouTube Terms of Service", async () => {
    const { text } = await request(await appFor(EMAIL)).get("/terms");
    expect(text).toContain(`you agree to be bound by the <a href="${YOUTUBE_TERMS_URL}"`);
    expect(text).toContain(`href="${GOOGLE_PRIVACY_URL}"`);
    expect(text).toMatch(/Effective \d{1,2} \w+ 20\d\d/);
  });

  it("opens exactly these three paths: everything else still needs the sign-in", async () => {
    const app = await appFor(EMAIL, fakeAccess().verifier);
    for (const path of ["/", "/privacy/", "/privacy/x", "/terms.html", "/home/x", "/Privacy", "/api/clips"]) {
      expect((await request(app).get(path)).status, path).toBe(403);
    }
    expect([...PUBLIC_PAGE_PATHS]).toEqual(["/home", "/privacy", "/terms"]);
  });

  it("answers 503, never a policy without a contact and never the app shell, while no address is set", async () => {
    const app = await appFor(null);
    for (const path of PUBLIC_PAGE_PATHS) {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
      expect(res.text).not.toContain("root");
    }
  });

  it("takes the address from SUPPORT_EMAIL, and only a plain email address", () => {
    expect(parseSupportEmail(" help@clips.example ")).toBe("help@clips.example");
    for (const bad of [undefined, "", "help", "help@clips", 'a"><script>@x.example', "a b@x.example", "a@x.example, b@x.example"]) {
      expect(parseSupportEmail(bad), String(bad)).toBeNull();
    }
    expect(loadConfig({ SUPPORT_EMAIL: EMAIL }).supportEmail).toBe(EMAIL);
    expect(loadConfig({}).supportEmail).toBeNull();
    // Demo mode only: a stand-in at example.com, which takes no mail.
    expect(loadConfig({ CLIPFARM_FAKES: "1" }).supportEmail).toBe("support@example.com");
  });

  it("uses the app's design tokens, with the values the app gives them", async () => {
    const { text } = await request(await appFor(EMAIL)).get("/privacy");
    const style = /<style>([\s\S]*?)<\/style>/.exec(text)![1]!;
    const appCss = readFileSync(join(import.meta.dirname, "..", "client", "src", "styles.css"), "utf8");
    const tokens = (css: string) => [...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => `${m[1]}: ${m[2]}`);
    const split = (css: string) => {
      const dark = css.indexOf("@media (prefers-color-scheme: dark)");
      return { light: tokens(css.slice(0, dark)), dark: tokens(css.slice(dark, css.indexOf("}\n}", dark))) };
    };
    const page = split(style);
    const real = split(appCss);
    expect(page.light.length).toBeGreaterThan(10);
    expect(page.dark.length).toBeGreaterThan(3);
    for (const token of page.light) expect(real.light).toContain(token);
    for (const token of page.dark) expect(real.dark).toContain(token);
    // Nothing but tokens for colour and size below the token blocks.
    const rules = style.slice(style.indexOf("* {"));
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});
