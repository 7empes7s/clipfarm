import { type FormEvent, useEffect, useState } from "react";
import type { ClipVersions, PostVersion } from "../../shared/publishing";
import { PLATFORM_RULES } from "../../shared/publishing";
import type { Platform } from "../../shared/types";
import { PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";

interface Draft {
  title: string;
  caption: string;
  hashtags: string;
  coverId: number | null;
}

const toDraft = (v: PostVersion): Draft => ({ title: v.title, caption: v.caption, hashtags: v.hashtags.join(" "), coverId: v.coverId });

/** The caption as it goes out: text, a blank line, hashtags (as the server joins them). */
function fullLength(d: Draft): number {
  const tags = d.hashtags.split(/[\s,]+/).filter(Boolean).join(" ");
  return (tags ? `${d.caption.trimEnd()}\n\n${tags}` : d.caption.trimEnd()).length;
}

/**
 * One sheet for a clip's versions: a title, caption, hashtags and cover per platform, each within
 * that platform's limits and keeping the campaign's required tags. The server checks it again.
 */
export function VersionsSheet({ clipId, title, onClose }: { clipId: number; title: string; onClose: () => void }) {
  const [data, setData] = useState<ClipVersions | null>(null);
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.versions(clipId).then(
      (v) => {
        if (!live) return;
        setData(v);
        setDraft(toDraft(v.versions.find((x) => x.platform === "tiktok")!));
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [clipId]);

  const pick = (p: Platform) => {
    setPlatform(p);
    setSaved(null);
    setError(null);
    if (data) setDraft(toDraft(data.versions.find((x) => x.platform === p)!));
  };

  const answer = async (fn: () => Promise<ClipVersions>, done: string) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const v = await fn();
      setData(v);
      setDraft(toDraft(v.versions.find((x) => x.platform === platform)!));
      setSaved(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (draft) void answer(() => api.saveVersion(clipId, platform, draft), `Saved for ${PLATFORM_LABELS[platform]}.`);
  };

  const rule = PLATFORM_RULES[platform];
  const current = data?.versions.find((v) => v.platform === platform);
  const tagCount = draft ? draft.hashtags.split(/[\s,]+/).filter(Boolean).length : 0;
  return (
    <Sheet id="versions-title" title="Versions per platform" onClose={onClose}>
      <p className="hint">{title}</p>
      {!data && !error && <p className="hint">Loading…</p>}
      {data && draft && (
        <form className="form" onSubmit={submit}>
          <div className="chips" role="group" aria-label="Platform">
            {data.versions.map((v) => (
              <button key={v.platform} type="button" className="ver-tab" aria-pressed={v.platform === platform} onClick={() => pick(v.platform)}>
                {PLATFORM_LABELS[v.platform]}
                {v.saved && <span className="ver-dot" aria-label="saved" />}
                {v.problems.length > 0 && <span className="ver-warn" aria-label="needs a fix">!</span>}
              </button>
            ))}
          </div>
          {data.requiredTags.length > 0 && <p className="hint">The campaign requires {data.requiredTags.join(" ")} on every platform.</p>}
          <label>
            Title{" "}
            <span className={`ver-count${draft.title.trim().length > rule.titleMax ? " over" : ""}`}>
              {draft.title.trim().length} / {rule.titleMax}
            </span>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </label>
          <label>
            Caption{" "}
            <span className={`ver-count${fullLength(draft) > rule.captionMax ? " over" : ""}`}>
              {fullLength(draft)} / {rule.captionMax} with hashtags
            </span>
            <textarea rows={6} value={draft.caption} onChange={(e) => setDraft({ ...draft, caption: e.target.value })} />
          </label>
          <label>
            Hashtags{" "}
            <span className={`ver-count${tagCount > Math.max(rule.hashtagsMax, data.requiredTags.length) ? " over" : ""}`}>
              {tagCount} / {Math.max(rule.hashtagsMax, data.requiredTags.length)} safe
            </span>
            <input value={draft.hashtags} onChange={(e) => setDraft({ ...draft, hashtags: e.target.value })} placeholder="#gta6 #gtavi" />
          </label>
          {data.covers.length > 0 && (
            <fieldset>
              <legend>Cover</legend>
              <div className="ver-covers">
                <label className="chip">
                  <input type="radio" name="cover" checked={draft.coverId === null} onChange={() => setDraft({ ...draft, coverId: null })} />
                  The platform's own frame
                </label>
                {data.covers.map((c) => (
                  <label key={c.id} className="ver-cover">
                    <input type="radio" name="cover" checked={draft.coverId === c.id} onChange={() => setDraft({ ...draft, coverId: c.id })} />
                    <img src={c.url} alt={c.label} loading="lazy" />
                  </label>
                ))}
              </div>
              <p className="hint">The cover is kept with the version; posting services that take no cover use their own frame.</p>
            </fieldset>
          )}
          {current && current.problems.length > 0 && (
            <ul className="notes ver-problems">
              {current.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {saved && (
            <p className="cal-message" role="status">
              {saved}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            Save for {PLATFORM_LABELS[platform]}
          </button>
          {current?.saved && (
            <button type="button" className="link" disabled={busy} onClick={() => void answer(() => api.resetVersion(clipId, platform), "Back to the version made from the clip.")}>
              Back to the version made from the clip
            </button>
          )}
        </form>
      )}
      {!data && error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
