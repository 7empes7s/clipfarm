# clipfarm

Turns other creators' streams and VODs (with their permission, through clipping programs such as
Whop Content Rewards) into short vertical clips for TikTok, YouTube Shorts and Instagram Reels.

It covers campaigns with permission records, a one-at-a-time job queue, and
**link → audio → word-timed transcript → ranked picks → captioned 9:16 clips**.

## Requirements

- Node 22+
- `ffmpeg` and `ffprobe` on the PATH
- `yt-dlp` on the PATH for real downloads (not needed for tests or the fake mode)

## Run it

```sh
npm install
npm run dev        # API on :3000 (tsx watch) + Vite client on :5173 with /api proxied
npm run build      # server to dist/server, client to dist/client
npm run preview    # built client + API on one port ($PORT, default 3000)
```

Try it without network or API keys (fake downloader makes a test clip, fake transcriber returns
fixed words, fake picker takes the loudest moments). Use a 40 s fake VOD so a 15-60 s clip fits:

```sh
npm run build && CLIPFARM_FAKES=1 FAKE_VOD_SEC=40 PORT=3000 npm run preview
```

## Settings (env vars)

Export them in your shell or put them in a `.env` you load yourself (never commit it; see
`.env.example`).

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port for the API and, in preview, the client |
| `DATA_DIR` | `./data` | Folder for the SQLite database |
| `OPENAI_API_KEY` | – | Key for the Whisper API. Without it, transcription jobs fail with a clear message |
| `TRANSCRIBER` | `openai` | `openai` or `fake` |
| `DOWNLOADER` | `yt-dlp` | `yt-dlp` or `fake` |
| `YT_DLP_BIN` | `yt-dlp` | Path to the yt-dlp binary |
| `CLIPFARM_FAKES` | – | `1` uses the fakes (downloader, transcriber, picker, posting) and adds a demo-clip button for e2e |
| `FAKE_VOD_SEC` | `10` | Length of the fake downloader's test clip |
| `PICKER` | `llm` | `llm` or `fake` (loudest moments, no AI: demos only, it cannot flag spoilers) |
| `LLM_API_KEY` | `OPENAI_API_KEY` | Key for the picking model. Without one, picking jobs fail with a clear message |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible API, e.g. `https://openrouter.ai/api/v1`, `https://api.cerebras.ai/v1` |
| `LLM_MODEL` | `gpt-4o-mini` | Model name at that API (must support JSON-schema answers) |
| `LLM_USD_PER_MTOK_IN` / `_OUT` | `0` | Model list prices per million tokens, for the cost per clip |
| `MAX_PICKS` | `15` | Most clips kept per VOD |
| `MEDIA_DIR` | `./media` | Where final clips, thumbnails and creator frames are kept (never committed) |
| `RENDER_PRESET` | `veryfast` | x264 preset for clips |
| `POSTIZ_URL` | – | Address you open Postiz at, e.g. `https://postiz.techinsiderbytes.com` |
| `POSTIZ_API_KEY` | – | From Postiz > Settings > Public API |
| `UPLOAD_POST_API_KEY` | – | Upload-Post API key (instead of Postiz) |
| `UPLOAD_POST_USER` | – | The Upload-Post profile that holds the accounts |
| `UPLOAD_POST_PLATFORMS` | `tiktok,youtube,instagram` | Platforms connected on that profile |
| `POSTING_SERVICE` | auto | `postiz`, `upload-post` or `none`; only needed when both are set |
| `POSTING_REFRESH_MINUTES` | `60` | How often post links and views are read (5 or more) |

## Posting (Postiz or Upload-Post)

clipfarm does not post to each platform itself. A posting service holds the connected accounts
(YouTube, TikTok, Instagram, X) and does the posting and scheduling; clipfarm uploads the
approved MP4 with its caption and keeps what is ours: the permission gate, spacing, Whop
submissions and earnings.

**Postiz** (self-hosted, see `ops/postiz/RUNBOOK.md` to install it):

1. In Postiz, connect the accounts, then copy the key from Settings > Public API.
2. Set `POSTIZ_URL` and `POSTIZ_API_KEY` on the clipfarm server and restart it.
3. Check the link with `npm run postiz:check`, then open Clips: it says "Posting through Postiz".

Only Postiz's public HTTP API is called, so none of its (AGPL) code is part of clipfarm. Its API
allows about 30 calls an hour, so views are read hourly and at most 20 posts per refresh.

**Upload-Post** (hosted, paid): set `UPLOAD_POST_API_KEY`, `UPLOAD_POST_USER` (the profile name)
and `UPLOAD_POST_PLATFORMS`. Its daily caps (YouTube 10, TikTok 15, Instagram 50) are shown when
posting and enforced before anything is sent.

Without either, posting says what to set, and **Export** still works: MP4, caption (credit, the
brief's links and hashtags) and a Share button for posting by hand from the phone.

Rules the server enforces before calling any service: the clip is approved, its creator has an
active permission record whose brief allows each platform (and is still in force at the post's
time), the service's daily cap is not passed, and each account keeps the spacing set in Clips >
"Spacing between posts" (default 3 a day, 90 minutes apart: busy accounts move to the next free
time). TikTok and YouTube keep API posts private until the posting app passes their review, and
Instagram needs a Business or Creator account.

Tracking: every post stores clip, platform, account, link, time, permission record and campaign.
Views come from the service on a timer, or by hand. "Mark sent to Whop" records the submission
(Whop has no clipper API). Stats shows posts, views and estimated earnings (views × pay per 1,000,
counted once a post reaches the campaign's minimum views) per campaign and platform, plus cost per
approved clip.

## Checks

```sh
npm run lint
npm run typecheck
npm test           # Vitest: unit tests + a real-ffmpeg fixture test on a generated sample
npm run test:e2e   # Playwright at 390 px against the built app, with fakes
```

No test touches the network or a paid API: yt-dlp, OpenAI, Postiz and Upload-Post are faked
(adapter tests use fixtures of their documented answers). Sample media is generated
by ffmpeg (`testsrc` + `sine`) during the test and deleted after; no media is committed.

## How it works

- `server/sources/`: a source is a creator plus permission records (`whop-campaign`,
  `direct-permission` or `own-content`, with campaign link, brief rules, pay per 1,000 views,
  minimum views, allowed platforms and end date). The server refuses to ingest from a source
  without an active record, both when the link is added and again when the job runs.
- `server/jobs/`: a SQLite-backed queue. One job at a time (the box is shared), automatic retries,
  cancel, progress, and a temp folder per job that is always removed.
- `server/pipeline/ingest/`: yt-dlp downloads **audio only** (`-f bestaudio`, ~60 MB per hour)
  plus title, duration and chapters. The video is not downloaded here; the render step will fetch
  only the picked sections.
- `server/pipeline/transcript/`: a `Transcriber` interface with word timestamps. The `openai`
  adapter calls `whisper-1` (`verbose_json`, word granularity), splits audio over 25 MB into
  overlapping chunks and merges the timings. The cost of each VOD is stored.
  Ingest also measures loudness per second (ffmpeg `ebur128`) while the audio is still there.
- `server/pipeline/picks/`: plain signals (loudness spikes, speech rate, laughing/shouting words,
  a slot for chat replay) find up to 30 candidate moments, snapped to sentence boundaries. An
  OpenAI-compatible model ranks them with a strict JSON schema: start, end, hook, title, score,
  reason, layout and flags (spoiler, story cutscene, ending, leak, breaks the brief). The campaign
  brief and the creator's off-limits note go into the prompt. Then a plain-code gate drops anything
  flagged, anything mentioning a "No …" phrase from the brief, overlaps, and windows that cannot be
  cut to 15-60 s on sentence boundaries. Dropped picks are stored with the reason and never render.
- `server/pipeline/render/`: one job per kept pick. yt-dlp downloads only that section (±3 s,
  ≤1080p30). Layouts: *stacked* (the creator's face cam box on top, gameplay below; the box is
  drawn once per creator in the gallery), *center* (9:16 gameplay crop), *full* (whole frame over a
  blurred copy). Karaoke captions (ASS, 2-4 words a line, the spoken word highlighted, clear of the
  bottom 20% and right 15%) and the hook for the first 2 s are burned in. Output: H.264 + AAC MP4,
  1080×1920, 30 fps, -14 LUFS, plus a thumbnail, in `media/clips/`. The section and captions are
  deleted with the job's temp folder. The server log prints time per step and cost per clip, and
  the gallery shows them on each clip.
- `server/publish/`: a `PostingService` interface with Postiz, Upload-Post and fake adapters,
  plus pure planners for the permission/brief gate, spacing, captions and earnings.
- `server/clips/`: clips with approve/reject; each rendered pick becomes one, waiting for review.
- `client/`: the phone-first gallery (React + Vite): Campaigns, Clips and Stats tabs.
- `shared/`: types used by both.

## Manual check with a real link (not run in CI)

1. Install `yt-dlp` and set `OPENAI_API_KEY`.
2. `npm run build && PORT=3000 npm run preview`, open http://localhost:3000.
3. Add a campaign you really have permission for, then paste a short VOD link (a few minutes).
4. The work queue shows "Downloading audio", then "Transcribing", then "Done". Open
   "Show transcript" and check the words and that the cost is a few cents at most.
