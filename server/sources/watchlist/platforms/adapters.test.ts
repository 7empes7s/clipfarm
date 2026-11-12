import { describe, expect, it } from "vitest";
import { KickClient } from "./kick.js";
import { parseTwitchDuration, TwitchClient } from "./twitch.js";
import { PlatformError } from "./types.js";
import { parseIsoDuration, YouTubeClient } from "./youtube.js";

/** A fetch that answers from a table of URL patterns and records what was called. No network. */
function fakeFetch(routes: [RegExp, unknown, number?][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find(([re]) => re.test(url));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route[1]), { status: route[2] ?? 200, headers: { "retry-after": "120" } });
  }) as typeof fetch;
  return { doFetch, calls };
}

describe("Twitch Helix", () => {
  const routes = (live: boolean): [RegExp, unknown][] => [
    [/id\.twitch\.tv\/oauth2\/token/, { access_token: "app-token", expires_in: 3600 }],
    [
      /helix\/streams/,
      { data: live ? [{ id: "s2", user_login: "jltomy", game_name: "Grand Theft Auto VI", title: "DAY 1", started_at: "2026-11-19T18:00:00Z", type: "live" }] : [] },
    ],
    [/helix\/users/, { data: [{ id: "42", login: "jltomy" }] }],
    [
      /helix\/videos/,
      {
        data: [
          { id: "v2", stream_id: "s2", title: "DAY 1", created_at: "2026-11-19T18:00:00Z", url: "https://www.twitch.tv/videos/v2", duration: "5h1m" },
          { id: "v1", stream_id: "s1", title: "prep", created_at: "2026-11-18T18:00:00Z", url: "https://www.twitch.tv/videos/v1", duration: "3h8m33s" },
        ],
      },
    ],
  ];

  it("says what to set without keys", () => {
    expect(new TwitchClient({}).missing).toBe("Add your Twitch key in Settings.");
  });

  it("uses an app token, reads archives and the live stream, and gives the VOD its live category", async () => {
    const { doFetch, calls } = fakeFetch(routes(true));
    const client = new TwitchClient({ clientId: "cid", clientSecret: "secret", fetch: doFetch });
    const first = await client.check("JLTomy");
    expect(first.live).toMatchObject({ platform: "twitch", game: "Grand Theft Auto VI", url: "https://www.twitch.tv/jltomy" });
    // The archive of the stream that is still live is left out until it ends.
    expect(first.vods.map((v) => v.externalId)).toEqual(["v1"]);
    expect(calls.find((c) => c.url.includes("/videos"))!.url).toContain("user_id=42&type=archive");
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer app-token");

    // Once the stream is over, its VOD carries the game seen while live.
    const routesAfter = routes(false);
    const after = fakeFetch(routesAfter);
    (client as unknown as { doFetch: typeof fetch }).doFetch = after.doFetch;
    const second = await client.check("jltomy");
    expect(second.vods[0]).toMatchObject({ externalId: "v2", category: "Grand Theft Auto VI", durationSec: 5 * 3600 + 60 });
    expect(after.calls.some((c) => c.url.includes("oauth2"))).toBe(false);
  });

  it("reads Helix durations", () => {
    expect(parseTwitchDuration("3h8m33s")).toBe(11313);
    expect(parseTwitchDuration("45s")).toBe(45);
    expect(parseTwitchDuration("")).toBeNull();
  });

  it("reports a missing channel without blaming the platform, and passes Retry-After on 429", async () => {
    const missing = fakeFetch([[/oauth2/, { access_token: "t", expires_in: 3600 }], [/streams/, { data: [] }], [/users/, { data: [] }]]);
    await expect(new TwitchClient({ clientId: "c", clientSecret: "s", fetch: missing.doFetch }).check("nobody")).rejects.toMatchObject({
      channelMissing: true,
    });
    const limited = fakeFetch([[/oauth2/, { access_token: "t", expires_in: 3600 }], [/streams/, {}, 429]]);
    const err = await new TwitchClient({ clientId: "c", clientSecret: "secret", fetch: limited.doFetch }).check("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toMatchObject({ retryAfterSec: 120, channelMissing: false });
    expect((err as Error).message).not.toContain("secret");
  });
});

describe("Kick public API", () => {
  it("reads finished VODs with their category and the live stream", async () => {
    const { doFetch, calls } = fakeFetch([
      [/channels\/3mr\/videos/, [
        { id: 1, created_at: "2026-11-18 20:00:00", session_title: "GTA RP", duration: 7_200_000, is_live: false, categories: [{ name: "Grand Theft Auto V" }], video: { uuid: "u1" } },
        { id: 2, created_at: "2026-11-19 20:00:00", session_title: "GTA VI", duration: 0, is_live: true, categories: [{ name: "Grand Theft Auto VI" }], video: { uuid: "u2" } },
      ]],
      [/channels\/3mr$/, { slug: "3mr", livestream: { is_live: true, session_title: "GTA VI", created_at: "2026-11-19 20:00:00", categories: [{ name: "Grand Theft Auto VI" }] } }],
    ]);
    const result = await new KickClient({ fetch: doFetch }).check("3MR");
    expect(result.vods).toEqual([
      {
        platform: "kick",
        externalId: "u1",
        url: "https://kick.com/3mr/videos/u1",
        title: "GTA RP",
        category: "Grand Theft Auto V",
        publishedAt: "2026-11-18T20:00:00.000Z",
        durationSec: 7200,
      },
    ]);
    expect(result.live).toMatchObject({ platform: "kick", game: "Grand Theft Auto VI", startedAt: "2026-11-19T20:00:00.000Z" });
    expect(calls.every((c) => c.url.startsWith("https://kick.com/api/v2/channels/3mr"))).toBe(true);
  });

  it("treats a 404 as a missing channel", async () => {
    await expect(new KickClient({ fetch: fakeFetch([]).doFetch }).check("nobody")).rejects.toMatchObject({ channelMissing: true });
  });
});

describe("YouTube Data API", () => {
  it("reads uploads and live replays through the uploads playlist, not search", async () => {
    const { doFetch, calls } = fakeFetch([
      [/\/channels\?/, { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] }],
      [/\/playlistItems\?/, { items: [{ contentDetails: { videoId: "a" } }, { contentDetails: { videoId: "b" } }, { contentDetails: { videoId: "c" } }] }],
      [
        /\/videos\?/,
        {
          items: [
            { id: "a", snippet: { title: "GTA 6 LIVE", publishedAt: "2026-11-19T19:00:00Z", liveBroadcastContent: "live" }, liveStreamingDetails: { actualStartTime: "2026-11-19T19:01:00Z" } },
            { id: "b", snippet: { title: "GTA VI stream replay", publishedAt: "2026-11-19T02:00:00Z", liveBroadcastContent: "none" }, contentDetails: { duration: "PT4H2M" }, liveStreamingDetails: { actualStartTime: "2026-11-18T22:00:00Z" } },
            { id: "c", snippet: { title: "short", publishedAt: "2026-11-19T03:00:00Z", liveBroadcastContent: "none" }, contentDetails: { duration: "PT45S" } },
          ],
        },
      ],
    ]);
    const client = new YouTubeClient({ apiKey: "yt-key", fetch: doFetch });
    const result = await client.check("IShowSpeed");
    expect(result.live).toMatchObject({ platform: "youtube", url: "https://www.youtube.com/watch?v=a" });
    expect(result.vods).toEqual([
      { platform: "youtube", externalId: "b", url: "https://www.youtube.com/watch?v=b", title: "GTA VI stream replay", category: null, publishedAt: "2026-11-18T22:00:00Z", durationSec: 4 * 3600 + 120 },
    ]);
    expect(calls[0]!.url).toContain("forHandle=%40IShowSpeed");
    expect(calls.some((c) => c.url.includes("/search"))).toBe(false);
    await client.check("IShowSpeed");
    expect(calls.filter((c) => c.url.includes("/channels?"))).toHaveLength(1);
  });

  it("says what to set without a key, and reads ISO durations", () => {
    expect(new YouTubeClient({}).missing).toBe("Add your YouTube key in Settings.");
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
  });
});
