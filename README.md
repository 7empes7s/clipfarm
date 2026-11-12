# clipfarm

Turns other creators' streams and VODs (with their permission, through clipping programs such as
Whop Content Rewards) into short vertical clips for TikTok, YouTube Shorts and Instagram Reels.

This first version covers the foundation: campaigns with permission records, a one-at-a-time job
queue, and **link → audio → word-timed transcript**.

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

Try it without network or API keys (fake downloader makes a 10 s test clip, fake transcriber
returns fixed words):

```sh
npm run build && CLIPFARM_FAKES=1 PORT=3000 npm run preview
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
| `CLIPFARM_FAKES` | – | `1` uses both fakes (demos, e2e) |

## Checks

```sh
npm run lint
npm run typecheck
npm test           # Vitest: unit tests + a real-ffmpeg fixture test on a generated sample
npm run test:e2e   # Playwright at 390 px against the built app, with fakes
```

No test touches the network or a paid API: yt-dlp and OpenAI are faked. Sample media is generated
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
- `client/`: the phone-first gallery (React + Vite).
- `shared/`: types used by both.

## Manual check with a real link (not run in CI)

1. Install `yt-dlp` and set `OPENAI_API_KEY`.
2. `npm run build && PORT=3000 npm run preview`, open http://localhost:3000.
3. Add a campaign you really have permission for, then paste a short VOD link (a few minutes).
4. The work queue shows "Downloading audio", then "Transcribing", then "Done". Open
   "Show transcript" and check the words and that the cost is a few cents at most.
