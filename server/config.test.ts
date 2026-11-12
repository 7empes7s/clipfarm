import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig: posting service", () => {
  it("uses Postiz when its address and key are set", () => {
    const c = loadConfig({ POSTIZ_URL: "https://postiz.example.com", POSTIZ_API_KEY: "k" });
    expect(c.postingService.name).toBe("postiz");
  });

  it("uses Upload-Post with its key, profile and platforms", async () => {
    const c = loadConfig({ UPLOAD_POST_API_KEY: "k", UPLOAD_POST_USER: "gtavimoments", UPLOAD_POST_PLATFORMS: "youtube, tiktok" });
    expect(c.postingService.name).toBe("upload-post");
    expect((await c.postingService.listAccounts()).map((a) => a.platform)).toEqual(["youtube", "tiktok"]);
  });

  it("follows POSTING_SERVICE when both are set", () => {
    const env = { POSTIZ_URL: "https://p.example.com", POSTIZ_API_KEY: "k", UPLOAD_POST_API_KEY: "k", UPLOAD_POST_USER: "u" };
    expect(loadConfig({ ...env, POSTING_SERVICE: "upload-post" }).postingService.name).toBe("upload-post");
  });

  it("falls back to export only without keys, and to the fake in demo mode", () => {
    expect(loadConfig({}).postingService.name).toBe("none");
    expect(loadConfig({ POSTING_SERVICE: "postiz" }).postingService.name).toBe("none");
    expect(loadConfig({ CLIPFARM_FAKES: "1", POSTIZ_URL: "https://p.example.com", POSTIZ_API_KEY: "k" }).postingService.name).toBe("fake");
  });

  it("reads the refresh interval, defaulting to an hour", () => {
    expect(loadConfig({}).postingRefreshMinutes).toBe(60);
    expect(loadConfig({ POSTING_REFRESH_MINUTES: "15" }).postingRefreshMinutes).toBe(15);
  });
});
