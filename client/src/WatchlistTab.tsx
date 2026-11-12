import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { ClipProgram, Source, WatchedCreator, WatchedCreatorInput, Watchlist, WatchPlatform } from "../../shared/types";
import { CLIP_PROGRAM_LABELS, CLIP_PROGRAMS, WATCH_PLATFORM_LABELS, WATCH_PLATFORMS } from "../../shared/types";
import { channelUrl } from "../../shared/watchlist";
import { api } from "./api";
import { ago } from "./format";
import { Sheet } from "./Sheet";

const NEEDS_PERMISSION = "Needs permission: join their program";

/** Who we follow: their channels, clipping program, who is live, and new VODs picked up on a timer. */
export function WatchlistTab({ sources, onQueued }: { sources: Source[]; onQueued: () => void }) {
  const [list, setList] = useState<Watchlist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState<WatchedCreator | "new" | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setList(await api.watchlist());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function checkNow() {
    setChecking(true);
    setError(null);
    try {
      setList(await api.checkWatchlist());
      onQueued();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  const replace = (c: WatchedCreator) => setList((l) => l && { ...l, creators: l.creators.map((x) => (x.id === c.id ? c : x)) });
  const closeSheet = useCallback(() => setEditing(null), []);
  const creators = list?.creators ?? [];
  const live = creators.filter((c) => c.live);
  const q = query.trim().toLowerCase();
  const shown = q ? creators.filter((c) => [c.name, ...c.channels.map((ch) => ch.handle)].some((s) => s.toLowerCase().includes(q))) : creators;

  return (
    <section aria-labelledby="watch-title">
      <div className="section-head">
        <h2 id="watch-title">Watchlist</h2>
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          Add a creator
        </button>
      </div>
      <p className="hint">
        New GTA VI streams from creators who allow clipping are picked up on their own, newest first.
        {list?.lastPollAt ? ` Last check ${ago(list.lastPollAt)}.` : ""}
      </p>
      <button type="button" className="link check-now" onClick={() => void checkNow()} disabled={checking}>
        {checking ? "Checking…" : "Check now"}
      </button>
      {list?.platforms
        .filter((p) => p.note)
        .map((p) => (
          <p key={p.platform} className="hint platform-note">
            {WATCH_PLATFORM_LABELS[p.platform]}: {p.configured ? p.note : <a href={`#settings/${p.platform}`}>{p.note}</a>}
          </p>
        ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="live-strip" aria-labelledby="live-title">
        <h3 id="live-title">Live now</h3>
        {live.length === 0 ? (
          <p className="hint">Nobody on the watchlist is live.</p>
        ) : (
          <ul data-testid="live-now">
            {live.map((c) => (
              <li key={c.id}>
                <a href={c.live!.url} target="_blank" rel="noreferrer">
                  <span className="live-dot" aria-hidden="true" />
                  <strong>{c.name}</strong>
                  <span>
                    {WATCH_PLATFORM_LABELS[c.live!.platform]}
                    {c.live!.game ? ` · ${c.live!.game}` : ""}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {creators.length > 8 && (
        <label className="find">
          <span className="sr-only">Find a creator</span>
          <input type="search" placeholder="Find a creator" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}

      {list && creators.length === 0 ? (
        <p className="empty">Nobody on the watchlist. Add the streamers you want to clip.</p>
      ) : (
        <ul className="stack">
          {shown.map((c) => (
            <CreatorRow key={c.id} creator={c} onChange={replace} onQueued={onQueued} onEdit={() => setEditing(c)} />
          ))}
        </ul>
      )}

      {editing && (
        <WatchSheet
          creator={editing === "new" ? null : editing}
          sources={sources}
          onClose={closeSheet}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function CreatorRow({
  creator: c,
  onChange,
  onQueued,
  onEdit,
}: {
  creator: WatchedCreator;
  onChange: (c: WatchedCreator) => void;
  onQueued: () => void;
  onEdit: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const allowed = c.permissionState === "active";

  async function toggle(on: boolean) {
    setSaving(true);
    setError(null);
    try {
      onChange(await api.setAutoIngest(c.id, on));
      onQueued();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="card watch" data-testid="watch-row">
      <div className="card-head">
        <h3>
          {c.live && <span className="live-dot" role="img" aria-label="Live now" />}
          {c.name}
        </h3>
        <span className={`state state-${allowed ? "active" : c.permissionState}`}>
          {allowed ? "Allowed" : c.permissionState === "expired" ? "Permission expired" : "Needs permission"}
        </span>
      </div>
      <div className="badges">
        {c.channels.map((ch) => (
          <a key={ch.platform} className={`badge badge-${ch.platform}`} href={channelUrl(ch)} target="_blank" rel="noreferrer">
            {WATCH_PLATFORM_LABELS[ch.platform]}
          </a>
        ))}
        {c.language && <span className="badge">{c.language.toUpperCase()}</span>}
      </div>
      <p className="program">
        <span className={`program-chip program-${c.program}`}>{CLIP_PROGRAM_LABELS[c.program]}</span>
        {c.programUrl && (
          <a href={c.programUrl} target="_blank" rel="noreferrer">
            Join program
          </a>
        )}
      </p>
      {!allowed && <p className="blocked">{NEEDS_PERMISSION}, then add it as a campaign in Sources.</p>}
      {c.live && (
        <p className="meta">
          Live on {WATCH_PLATFORM_LABELS[c.live.platform]}
          {c.live.game ? `: ${c.live.game}` : ""}
        </p>
      )}
      <p className="meta last-vod">
        {c.lastVod ? (
          <>
            <span>
              Last VOD ({WATCH_PLATFORM_LABELS[c.lastVod.platform]}, {ago(c.lastVod.publishedAt)}): {c.lastVod.title || "untitled"}
            </span>
            {/* Without permission the line above already says why. */}
            {(allowed || c.lastVod.status === "queued") && (
              <span className={c.lastVod.status === "queued" ? "vod-ready" : undefined}>
                {c.lastVod.status === "queued" ? "Queued for transcript" : c.lastVod.skipReason}
              </span>
            )}
          </>
        ) : (
          <span>No VOD seen yet</span>
        )}
      </p>
      <div className="watch-foot">
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={c.autoIngest}
            disabled={saving || (!allowed && !c.autoIngest)}
            onChange={(e) => void toggle(e.target.checked)}
          />
          Auto-ingest
        </label>
        <button type="button" className="link" onClick={onEdit}>
          Edit
        </button>
      </div>
      {c.note && <p className="hint note">{c.note}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function WatchSheet({
  creator,
  sources,
  onClose,
  onSaved,
}: {
  creator: WatchedCreator | null;
  sources: Source[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [program, setProgram] = useState<ClipProgram>(creator?.program ?? "none");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const handle = (p: WatchPlatform) => creator?.channels.find((c) => c.platform === p)?.handle ?? "";

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim();
    const input: WatchedCreatorInput = {
      name: text("name"),
      channels: WATCH_PLATFORMS.map((platform) => ({ platform, handle: text(platform) })).filter((c) => c.handle),
      language: text("language"),
      games: text("games").split(",").map((g) => g.trim()).filter(Boolean),
      program,
      programUrl: text("programUrl") || null,
      note: text("note"),
      sourceId: text("sourceId") ? Number(text("sourceId")) : null,
    };
    setSaving(true);
    setError(null);
    try {
      if (creator) await api.updateWatched(creator.id, input);
      else await api.addWatched(input);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  async function remove() {
    if (!creator || !window.confirm(`Remove ${creator.name} from the watchlist?`)) return;
    try {
      await api.removeWatched(creator.id);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Sheet id="watch-sheet-title" title={creator ? `Edit ${creator.name}` : "Add a creator"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input name="name" required autoComplete="off" defaultValue={creator?.name} />
        </label>
        <fieldset>
          <legend>
            Channels <span className="hint">name or link, at least one</span>
          </legend>
          <div className="form">
            {WATCH_PLATFORMS.map((p) => (
              <label key={p}>
                {WATCH_PLATFORM_LABELS[p]}
                <input name={p} autoComplete="off" defaultValue={handle(p)} placeholder={p === "youtube" ? "@handle" : "channel name"} />
              </label>
            ))}
          </div>
        </fieldset>
        <div className="row">
          <label>
            Language
            <input name="language" autoComplete="off" defaultValue={creator?.language} placeholder="en" />
          </label>
          <label>
            Games <span className="hint">comma between</span>
            <input name="games" autoComplete="off" defaultValue={(creator?.games ?? ["GTA VI"]).join(", ")} />
          </label>
        </div>
        <label>
          Clipping program
          <select value={program} onChange={(e) => setProgram(e.target.value as ClipProgram)}>
            {CLIP_PROGRAMS.map((p) => (
              <option key={p} value={p}>
                {CLIP_PROGRAM_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Program link <span className="hint">where to join</span>
          <input name="programUrl" type="url" inputMode="url" defaultValue={creator?.programUrl ?? ""} placeholder="https://whop.com/…" />
        </label>
        <label>
          Campaign (permission) <span className="hint">found by name if not picked</span>
          <select name="sourceId" defaultValue={creator?.sourceId ?? ""}>
            <option value="">Find by name</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.creatorName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note
          <textarea name="note" rows={2} defaultValue={creator?.note} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {creator && (
          <button type="button" className="danger" onClick={() => void remove()}>
            Remove from watchlist
          </button>
        )}
      </form>
    </Sheet>
  );
}
