import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { CreatorInfo, Output } from "../../shared/creator";
import { OUTPUT_FORMAT_LABELS } from "../../shared/creator";
import type { Source, Vod, WatchedCreator } from "../../shared/types";
import { WATCH_PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { EmptyState } from "./ui";
import { sendFile } from "./upload";

type Mode = "file" | "link";

function chapterTime(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

function duration(sec: number | null): string {
  if (sec === null) return "";
  return sec < 60 ? `${Math.round(sec)} s` : `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
}

/** Your own long videos (or a client's) into clips for every platform: upload or link, then the other formats. */
export function CreatorTab({ sources, vods, onAdded }: { sources: Source[]; vods: Vod[]; onAdded: () => void }) {
  const [info, setInfo] = useState<CreatorInfo | null>(null);
  const [watched, setWatched] = useState<WatchedCreator[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, w] = await Promise.all([api.creator(), api.watchlist().catch(() => null)]);
      setInfo(c);
      setWatched((w?.creators ?? []).filter((x) => x.games.includes("*")));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const own = sources.filter((s) => s.permissions.some((p) => p.kind === "own-content"));
  const outputs = info?.outputs ?? [];
  const byVod = new Map<number, Output[]>();
  for (const o of outputs) byVod.set(o.vodId, [...(byVod.get(o.vodId) ?? []), o]);

  return (
    <section aria-labelledby="creator-title" className="creator">
      <div className="section-head">
        <h2 id="creator-title">Creator</h2>
      </div>
      <p className="hint">
        Your own long videos, or a client's, cut into shorts for the Inbox plus square, wide, best-of and podcast cuts
        {info?.workspace ? ` for ${info.workspace.name}` : ""}.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <AddVideo
        own={own}
        onAdded={() => {
          onAdded();
          void load();
        }}
      />

      <h3 className="creator-sub">Your shows</h3>
      {own.length === 0 ? (
        <p className="hint">Nothing yet. Add a video above and its show appears here.</p>
      ) : (
        <ul className="stack">
          {own.map((s) => (
            <ShowCard key={s.id} source={s} vods={vods.filter((v) => v.sourceId === s.id)} watched={watched.filter((w) => w.sourceId === s.id)} onChange={onAdded} />
          ))}
        </ul>
      )}

      <h3 className="creator-sub">Other formats</h3>
      {outputs.length === 0 ? (
        <EmptyState icon="creator" title="No other formats yet">
          Once a video's shorts are cut, its square, wide and best-of versions (or audiograms for a podcast) show up here with a
          suggested title, description and chapters.
        </EmptyState>
      ) : (
        [...byVod.entries()].map(([vodId, outs]) => (
          <div key={vodId} className="output-group">
            <h4>{vods.find((v) => v.id === vodId)?.title ?? `Video ${vodId}`}</h4>
            <ul className="outputs">
              {outs.map((o) => (
                <OutputCard key={o.id} output={o} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function AddVideo({ own, onAdded }: { own: Source[]; onAdded: () => void }) {
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [showId, setShowId] = useState<number | "new">("new");
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (n: string) => String(f.get(n) ?? "").trim();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      let uploadId: number | null = null;
      if (mode === "file") {
        if (!file) throw new Error("Pick a video or audio file.");
        abort.current = new AbortController();
        uploadId = await sendFile(file, setProgress, abort.current.signal);
      }
      const added = await api.addCreatorVideo({
        sourceId: showId === "new" ? null : showId,
        name: text("name"),
        ownerName: text("ownerName"),
        attested: f.get("attested") === "on",
        link: mode === "link" ? text("link") : null,
        uploadId,
      });
      setDone(
        added.watching
          ? `Watching ${added.watching.channels.map((c) => `${WATCH_PLATFORM_LABELS[c.platform]} ${c.handle}`).join(", ")}: each new video is clipped and waits in the Inbox.`
          : `${added.feedTitle ? `${added.feedTitle}: the newest episode is` : "Added. The video is"} being cut into clips; they land in the Inbox.`,
      );
      form.reset();
      setFile(null);
      onAdded();
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <form className="card form add-video" onSubmit={(e) => void submit(e)} aria-label="Add a video">
      <div className="segmented" role="radiogroup" aria-label="How to add it">
        {(["file", "link"] as const).map((m) => (
          <label key={m} className={mode === m ? "on" : undefined}>
            <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
            {m === "file" ? "Upload a file" : "Paste a link"}
          </label>
        ))}
      </div>
      {mode === "file" ? (
        <label>
          Video or audio file
          <span className="hint">Big files are fine: it carries on if the connection drops.</span>
          <input type="file" accept="video/*,audio/*,.mkv,.m4a" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      ) : (
        <label>
          Link
          <span className="hint">A video or a channel on YouTube (@name), Twitch or Kick, a podcast feed, or a Drive or Dropbox file. A channel or feed is watched for new videos.</span>
          <input name="link" type="url" inputMode="url" placeholder="https://…" required />
        </label>
      )}
      <div className="field">
        <label htmlFor="creator-show">Show</label>
        <select id="creator-show" value={showId} onChange={(e) => setShowId(e.target.value === "new" ? "new" : Number(e.target.value))}>
          <option value="new">A new show</option>
          {own.map((s) => (
            <option key={s.id} value={s.id}>
              {s.creatorName}
            </option>
          ))}
        </select>
      </div>
      {showId === "new" && (
        <label>
          Channel or show name
          <input name="name" required autoComplete="off" placeholder="My podcast" />
        </label>
      )}
      <label>
        Who owns the videos
        <input name="ownerName" required autoComplete="name" placeholder="You, or your client's name" />
      </label>
      <label className="switch attest">
        <input type="checkbox" name="attested" required />
        I own these videos, or have the owner's OK to clip and post them.
      </label>
      {progress !== null && (
        <div className="upload-progress">
          <progress value={progress} max={1} aria-label="Upload" />
          <span>{Math.floor(progress * 100)}% sent</span>
          <button type="button" className="link" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="ok-note" role="status">
          {done}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? (progress !== null ? "Uploading…" : "Adding…") : mode === "file" ? "Upload and make clips" : "Add and make clips"}
      </button>
    </form>
  );
}

function ShowCard({ source, vods, watched, onChange }: { source: Source; vods: Vod[]; watched: WatchedCreator[]; onChange: () => void }) {
  const record = source.permissions.find((p) => p.kind === "own-content")!;
  const [owner, setOwner] = useState(record.ownerName ?? "");
  const [error, setError] = useState<string | null>(null);

  async function attest(e: FormEvent) {
    e.preventDefault();
    try {
      await api.attest(record.id, owner);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <li className="card">
      <div className="card-head">
        <h3>{source.creatorName}</h3>
        <span className={`state ${record.attestedAt ? "state-active" : "state-needs-review"}`}>{record.attestedAt ? "Yours" : "Needs your OK"}</span>
      </div>
      <p className="meta">
        {record.attestedAt ? `Owned by ${record.ownerName}, confirmed ${new Date(record.attestedAt).toLocaleDateString()}. ` : ""}
        {vods.length} video{vods.length === 1 ? "" : "s"}. AI features {source.aiAllowed ? "on" : "off"}.
      </p>
      {watched.map((w) => (
        <p key={w.id} className="meta">
          Watching {w.channels.map((c) => `${WATCH_PLATFORM_LABELS[c.platform]} ${c.handle}`).join(", ")}
          {w.lastVod ? `: last new video “${w.lastVod.title}”` : ": no new video yet"}.
        </p>
      ))}
      {source.channelUrls
        .filter((u) => !/twitch\.tv|kick\.com|youtube\.com/.test(u))
        .map((u) => (
          <p key={u} className="meta">
            Watching feed <span className="url">{u}</span>
          </p>
        ))}
      {!record.attestedAt && (
        <form className="form attest-form" onSubmit={(e) => void attest(e)}>
          <label>
            Who owns the videos
            <input value={owner} onChange={(e) => setOwner(e.target.value)} required />
          </label>
          <button type="submit">I own these videos</button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
    </li>
  );
}

function OutputCard({ output: o }: { output: Output }) {
  const [copied, setCopied] = useState(false);
  const text = [o.title, o.description].filter(Boolean).join("\n\n");
  return (
    <li className={`card output output-${o.format}`}>
      <div className="output-media">
        {o.thumbUrl ? <img src={o.thumbUrl} alt="" loading="lazy" /> : <div className="output-wait">{o.status === "failed" ? "Failed" : "Making…"}</div>}
        <span className="output-format">{OUTPUT_FORMAT_LABELS[o.format]}</span>
      </div>
      <div className="output-body">
        <strong>{o.title || OUTPUT_FORMAT_LABELS[o.format]}</strong>
        <span className="meta">{o.status === "done" ? duration(o.durationSec) : o.status === "failed" ? o.error : "Being made"}</span>
        {o.status === "done" && (
          <>
            <details>
              <summary>Description{o.chapters.length > 0 ? " and chapters" : ""}</summary>
              <p className="output-desc">{o.description}</p>
              {o.chapters.length > 0 && (
                <ol className="chapters">
                  {o.chapters.map((c) => (
                    <li key={c.startSec}>
                      {chapterTime(c.startSec)} {c.title}
                    </li>
                  ))}
                </ol>
              )}
            </details>
            <div className="output-actions">
              <a className="button" href={o.videoUrl!} download={`${o.format}-${o.id}.mp4`}>
                Download
              </a>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
              >
                {copied ? "Copied" : "Copy title and text"}
              </button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}
