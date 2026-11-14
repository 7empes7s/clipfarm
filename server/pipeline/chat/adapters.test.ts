import { describe, expect, it } from "vitest";
import { FakeChatSource, FakeChatTap } from "./fake.js";
import { kickContent, KickChatSource, kickVideoId, parseKickEvent } from "./kick.js";
import { chatSources, chatTaps, KickChatTap, TwitchChatTap, type WsLike } from "./live.js";
import { parseIrcLine, TwitchChatSource, twitchVideoId } from "./twitch.js";

/** A fetch that answers from a table of URL → JSON, recording each call. No network. */
function fakeFetch(answer: (url: string, body: unknown) => unknown) {
  const calls: { url: string; body: unknown; headers: unknown }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), body, headers: init?.headers });
    const json = answer(String(url), body);
    return json === undefined ? new Response("nope", { status: 404 }) : Response.json(json);
  }) as typeof fetch;
  return { impl, calls };
}

const edge = (sec: number, login: string, fragments: { text: string; emote?: { emoteID: string } | null }[], cursor: string) => ({
  cursor,
  node: { contentOffsetSeconds: sec, commenter: { login }, message: { fragments } },
});

describe("Twitch chat replay", () => {
  it("reads the video id from VOD links only", () => {
    expect(twitchVideoId("https://www.twitch.tv/videos/2299")).toBe("2299");
    expect(twitchVideoId("https://twitch.tv/somebody/v/77")).toBe("77");
    expect(twitchVideoId("https://www.twitch.tv/somebody")).toBeNull();
    expect(twitchVideoId("https://www.youtube.com/watch?v=x")).toBeNull();
  });

  it("pages through the chat with the cursor, keeping emote names, and adds community clips from Helix", async () => {
    const pages = [
      { data: { video: { comments: { edges: [edge(1, "a", [{ text: "hi" }], "c1"), edge(4, "b", [{ text: "KEKW", emote: { emoteID: "1" } }, { text: " lol" }], "c2")], pageInfo: { hasNextPage: true } } } } },
      { data: { video: { comments: { edges: [edge(12, "c", [{ text: "no way" }], "c3")], pageInfo: { hasNextPage: false } } } } },
    ];
    const { impl, calls } = fakeFetch(() => pages[calls.length - 1]);
    const helixCalls: string[] = [];
    const helix = async <T,>(path: string): Promise<T> => {
      helixCalls.push(path);
      if (path.startsWith("/videos")) return { data: [{ user_id: "9", created_at: "2026-11-10T18:00:00Z", duration: "1h" }] } as T;
      return { data: [{ video_id: "55", vod_offset: 100, duration: 30 }, { video_id: "other", vod_offset: 5, duration: 20 }, { video_id: "55", vod_offset: null, duration: 20 }] } as T;
    };
    const log = await new TwitchChatSource({ fetch: impl, helix: () => helix }).fetch("https://www.twitch.tv/videos/55", { durationSec: 3600 });
    expect(log!.messages).toEqual([
      { sec: 1, user: "a", text: "hi", emotes: [] },
      { sec: 4, user: "b", text: "KEKW lol", emotes: ["KEKW"] },
      { sec: 12, user: "c", text: "no way", emotes: [] },
    ]);
    expect(calls.map((c) => (c.body as { variables: unknown }).variables)).toEqual([{ id: "55", offset: 0 }, { id: "55", cursor: "c2" }]);
    expect(calls[0]!.url).toBe("https://gql.twitch.tv/gql");
    expect(log!.clips).toEqual([{ startSec: 100, endSec: 130 }]);
    expect(helixCalls[1]).toContain("broadcaster_id=9");
  });

  it("has no chat for other links, and skips clips without the Twitch key", async () => {
    const { impl, calls } = fakeFetch(() => ({ data: { video: { comments: { edges: [], pageInfo: { hasNextPage: false } } } } }));
    const source = new TwitchChatSource({ fetch: impl, helix: () => null });
    expect(await source.fetch("https://kick.com/x/videos/1", { durationSec: 10 })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await source.fetch("https://www.twitch.tv/videos/1", { durationSec: 10 })).toEqual({ messages: [], clips: [] });
  });

  it("reads live IRC lines with their emotes and answers PING", () => {
    expect(parseIrcLine("PING :tmi.twitch.tv")).toBe("ping");
    expect(parseIrcLine("@badge-info=;emotes=25:0-4,12-16/1902:6-10;id=x :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :Kappa Keepo Kappa")).toEqual({
      sec: 0, user: "bob", text: "Kappa Keepo Kappa", emotes: ["Kappa", "Keepo"],
    });
    expect(parseIrcLine(":tmi.twitch.tv 001 justinfan1 :Welcome")).toBeNull();
  });
});

describe("Kick chat replay", () => {
  const uuid = "0b7c3a4e-1111-2222-3333-444455556666";

  it("reads the uuid and emotes", () => {
    expect(kickVideoId(`https://kick.com/tjr/videos/${uuid}`)).toBe(uuid);
    expect(kickVideoId(`https://kick.com/video/${uuid}`)).toBe(uuid);
    expect(kickVideoId("https://kick.com/tjr")).toBeNull();
    expect(kickContent("[emote:37226:KEKW] lol [emote:1:W]")).toEqual({ text: "KEKW lol W", emotes: ["KEKW", "W"] });
  });

  it("walks the chat history through the stream and finds the broadcast's clips", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("/api/v1/video/")) return { livestream: { id: 7, channel_id: 42, start_time: "2026-11-10 18:00:00", duration: 20_000, channel: { slug: "tjr" } } };
      if (url.includes("/clips")) return { clips: [{ livestream_id: 7, created_at: "2026-11-10T18:00:15Z", duration: 10 }, { livestream_id: 8, created_at: "2026-11-10T18:00:15Z", duration: 10 }] };
      const at = new URL(url).searchParams.get("start_time");
      if (at === "2026-11-10T18:00:00.000Z") {
        return { data: { messages: [
          { id: "1", created_at: "2026-11-10T18:00:01Z", content: "[emote:1:KEKW]", sender: { username: "a" } },
          { id: "2", created_at: "2026-11-10T18:00:03Z", content: "no way", sender: { username: "b" } },
        ] } };
      }
      if (at === "2026-11-10T18:00:03.001Z") return { data: { messages: [{ id: "2", created_at: "2026-11-10T18:00:03Z", content: "no way", sender: { username: "b" } }] } };
      return { data: { messages: [] } };
    });
    const log = await new KickChatSource({ fetch: impl }).fetch(`https://kick.com/tjr/videos/${uuid}`, { durationSec: 20 });
    expect(log!.messages).toEqual([
      { sec: 1, user: "a", text: "KEKW", emotes: ["KEKW"] },
      { sec: 3, user: "b", text: "no way", emotes: [] },
    ]);
    expect(log!.clips).toEqual([{ startSec: 5, endSec: 15 }]);
    // After a page, the walk goes on from its last message; after an empty one, 5 s on. It stops at the end of the stream.
    const starts = calls.filter((c) => c.url.includes("/messages")).map((c) => new URL(c.url).searchParams.get("start_time"));
    expect(starts).toEqual(["2026-11-10T18:00:00.000Z", "2026-11-10T18:00:03.001Z", "2026-11-10T18:00:08.001Z", "2026-11-10T18:00:13.001Z", "2026-11-10T18:00:18.001Z"]);
  });

  it("reads live Pusher events", () => {
    expect(parseKickEvent(JSON.stringify({ event: "pusher:ping", data: {} }))).toBe("ping");
    expect(parseKickEvent(JSON.stringify({ event: "App\\Events\\ChatMessageEvent", data: JSON.stringify({ content: "[emote:2:LUL] W", sender: { username: "z" } }) }))).toEqual({
      sec: 0, user: "z", text: "LUL W", emotes: ["LUL"],
    });
    expect(parseKickEvent("not json")).toBeNull();
  });
});

/** A websocket stand-in: records what is sent; the test pushes frames in. */
class FakeWs implements WsLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.closed = true;
  }
}

describe("live chat taps", () => {
  it("Twitch: joins the channel anonymously, answers PING and times each message from when it began", async () => {
    let ws!: FakeWs;
    let t = 1000;
    const stop = new AbortController();
    const heard = new TwitchChatTap({ ws: (url) => (ws = new FakeWs(url)), now: () => t }).listen({ platform: "twitch", handle: "SomeOne" }, stop.signal);
    ws.onopen!();
    expect(ws.url).toBe("wss://irc-ws.chat.twitch.tv:443");
    expect(ws.sent).toContain("JOIN #someone");
    t = 6000;
    ws.onmessage!({ data: "PING :tmi.twitch.tv\r\n:a!a@a.tmi.twitch.tv PRIVMSG #someone :KEKW\r\n" });
    expect(ws.sent.at(-1)).toBe("PONG :tmi.twitch.tv");
    stop.abort();
    expect(await heard).toEqual({ messages: [{ sec: 5, user: "a", text: "KEKW", emotes: [] }], clips: [] });
    expect(ws.closed).toBe(true);
  });

  it("Kick: subscribes to the channel's chatroom", async () => {
    let ws!: FakeWs;
    const { impl } = fakeFetch(() => ({ chatroom: { id: 99 } }));
    const stop = new AbortController();
    const heard = new KickChatTap({ ws: (url) => (ws = new FakeWs(url)), fetch: impl, now: () => 0 }).listen({ platform: "kick", handle: "tjr" }, stop.signal);
    await new Promise((r) => setTimeout(r, 0));
    ws.onopen!();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ event: "pusher:subscribe", data: { auth: "", channel: "chatrooms.99.v2" } });
    ws.onmessage!({ data: JSON.stringify({ event: "App\\Events\\ChatMessageEvent", data: JSON.stringify({ content: "W", sender: { username: "q" } }) }) });
    stop.abort();
    expect((await heard)!.messages).toEqual([{ sec: 0, user: "q", text: "W", emotes: [] }]);
  });

  it("a connection that never opened is no chat, and a failing tap never fails the recording", async () => {
    const stop = new AbortController();
    stop.abort();
    expect(await new TwitchChatTap({ ws: (url) => new FakeWs(url) }).listen({ platform: "twitch", handle: "x" }, stop.signal)).toBeNull();
    const { impl } = fakeFetch(() => undefined);
    const taps = chatTaps([new KickChatTap({ fetch: impl })]);
    expect(await taps.listen({ platform: "kick", handle: "gone" }, new AbortController().signal)).toBeNull();
    expect(await taps.listen({ platform: "youtube", handle: "x" }, new AbortController().signal)).toBeNull();
  });
});

describe("fakes and the source chain", () => {
  it("asks each source in turn; uploads and YouTube have no chat", async () => {
    const twitch = new FakeChatSource({ "https://www.twitch.tv/videos/1": { messages: [], clips: [{ startSec: 1, endSec: 2 }] } });
    const kick = new FakeChatSource();
    const chain = chatSources([twitch, kick]);
    expect((await chain.fetch("https://www.twitch.tv/videos/1", { durationSec: 60 }))!.clips).toHaveLength(1);
    expect((await chain.fetch("https://kick.com/a/videos/b", { durationSec: 60 }))!.messages.length).toBeGreaterThan(0);
    expect(await chain.fetch("https://www.youtube.com/watch?v=x", { durationSec: 60 })).toBeNull();
    expect(await chain.fetch("upload:3", { durationSec: 60 })).toBeNull();
  });

  it("the fake tap hands its log back when the segment ends", async () => {
    const stop = new AbortController();
    const tap = new FakeChatTap({ messages: [{ sec: 1, user: "a", text: "W" }], clips: [] });
    const heard = tap.listen({ platform: "kick", handle: "tjr" }, stop.signal);
    stop.abort();
    expect((await heard)!.messages).toHaveLength(1);
    expect(tap.listened).toEqual([{ platform: "kick", handle: "tjr" }]);
  });
});
