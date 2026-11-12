import { type FormEvent, useState } from "react";
import type { Clip, Platform, PostingInfo, Source } from "../../shared/types";
import { PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";

/** Platforms the source's active permissions allow (the server checks again). */
export function allowedPlatforms(source: Source | undefined): Platform[] {
  const now = Date.now();
  const active = source?.permissions.filter((p) => !p.reviewReason && (!p.expiresAt || new Date(p.expiresAt).getTime() > now)) ?? [];
  return [...new Set(active.flatMap((p) => p.allowedPlatforms))];
}

/** "Post": pick accounts and a time; the server checks permission, brief, caps and spacing. */
export function PostSheet({
  clip,
  source,
  info,
  onClose,
  onPosted,
}: {
  clip: Clip;
  source: Source | undefined;
  info: PostingInfo;
  onClose: () => void;
  onPosted: () => void;
}) {
  const allowed = allowedPlatforms(source);
  const [picked, setPicked] = useState<string[]>([]);
  const [later, setLater] = useState(false);
  const [at, setAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      await api.postClip(clip.id, picked, later && at ? new Date(at).toISOString() : null);
      onPosted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  const caps = Object.entries(info.dailyCaps) as [Platform, number][];
  return (
    <Sheet id="post-sheet-title" title="Post this clip" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint">{clip.title}</p>
        {info.accountsError && (
          <p className="error" role="alert">
            {info.accountsError}
          </p>
        )}
        {info.accounts.length === 0 && !info.accountsError ? (
          <p className="empty">
            {info.service === "none"
              ? "No posting service is set up yet. Use Export to post by hand."
              : `No accounts are connected in ${info.label} yet. Connect them there first.`}
          </p>
        ) : (
          <fieldset>
            <legend>Accounts</legend>
            <div className="chips">
              {info.accounts.map((a) => {
                const notAllowed = !allowed.includes(a.platform);
                return (
                  <label key={a.id} className="chip">
                    <input
                      type="checkbox"
                      checked={picked.includes(a.id)}
                      disabled={a.disabled || notAllowed}
                      onChange={() => toggle(a.id)}
                    />
                    {a.name} · {PLATFORM_LABELS[a.platform]}
                    {a.disabled && <span className="hint">disconnected</span>}
                    {notAllowed && !a.disabled && <span className="hint">not in the brief</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        <fieldset>
          <legend>When</legend>
          <div className="chips">
            <label className="chip">
              <input type="radio" name="when" checked={!later} onChange={() => setLater(false)} />
              Now
            </label>
            <label className="chip">
              <input type="radio" name="when" checked={later} onChange={() => setLater(true)} />
              At a time
            </label>
          </div>
        </fieldset>
        {later && (
          <label>
            Date and time
            <input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
        )}
        <p className="hint">
          Each account posts at most {info.rules.maxPerDay} times a day, {info.rules.minGapMinutes} minutes apart. Posts
          on a busy account move to its next free time.
        </p>
        {caps.length > 0 && (
          <p className="hint">
            {info.label} daily limits:{" "}
            {caps.map(([p, cap]) => `${PLATFORM_LABELS[p]} ${info.usedToday[p] ?? 0} of ${cap}`).join(", ")}
          </p>
        )}
        <ul className="notes">
          {info.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={sending || picked.length === 0}>
          {sending ? "Posting…" : later ? "Schedule" : "Post now"}
        </button>
      </form>
    </Sheet>
  );
}
