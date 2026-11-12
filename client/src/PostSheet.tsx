import { type FormEvent, useEffect, useState } from "react";
import type { AccountChoice, Clip, Platform, PostingInfo, SkippedAccount, Source } from "../../shared/types";
import { ACCOUNT_ROLE_LABELS, PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";

/** Platforms the source's active permissions allow (the server checks again). */
export function allowedPlatforms(source: Source | undefined): Platform[] {
  const now = Date.now();
  const active = source?.permissions.filter((p) => !p.expiresAt || new Date(p.expiresAt).getTime() > now) ?? [];
  return [...new Set(active.flatMap((p) => p.allowedPlatforms))];
}

/**
 * "Post": pick accounts and a time; the server checks permission, brief, caps and spacing.
 * Main accounts whose niche fits the clip start ticked.
 */
export function PostSheet({
  clip,
  info,
  gap,
  onClose,
  onPosted,
}: {
  clip: Clip;
  info: PostingInfo;
  /** Why no account takes this clip's kind of permission, when that is so. */
  gap: string | null;
  onClose: () => void;
  onPosted: (skipped: SkippedAccount[]) => void;
}) {
  const [choices, setChoices] = useState<AccountChoice[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [later, setLater] = useState(false);
  const [at, setAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let live = true;
    api.clipAccounts(clip.id).then(
      (c) => {
        if (!live) return;
        setChoices(c);
        setPicked(c.filter((x) => x.suggested).map((x) => x.account.id));
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [clip.id]);

  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      const { skipped } = await api.postClip(clip.id, picked, later && at ? new Date(at).toISOString() : null);
      onPosted(skipped);
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
        {info.accountsError && !error && (
          <p className="error" role="alert">
            {info.accountsError}
          </p>
        )}
        {!choices ? (
          !error && <p className="hint">Loading accounts…</p>
        ) : choices.length === 0 && !info.accountsError ? (
          <p className="empty">
            {info.service === "none"
              ? "No posting service is set up yet. Use Export to post by hand."
              : `No accounts are connected in ${info.label} yet. Connect them there first.`}
          </p>
        ) : (
          <fieldset>
            <legend>Accounts</legend>
            <div className="chips" data-testid="account-picker">
              {choices.map(({ account: a, canPost, note }) => (
                <label key={a.id} className="chip">
                  <input type="checkbox" checked={picked.includes(a.id)} disabled={!canPost} onChange={() => toggle(a.id)} />
                  {a.name} · {PLATFORM_LABELS[a.platform]}
                  {a.role === "burner" && <span className="state role-burner">{ACCOUNT_ROLE_LABELS.burner}</span>}
                  {note && <span className="hint">{note}</span>}
                </label>
              ))}
            </div>
            {gap ? (
              <p className="error" role="alert">
                {gap}
              </p>
            ) : (
              <p className="hint">Main accounts whose niche fits this clip start ticked. Change them as you like.</p>
            )}
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
          Unless it has its own pace, each account posts at most {info.rules.maxPerDay} times a day,{" "}
          {info.rules.minGapMinutes} minutes apart. Posts on a busy account move to its next free time, and the same clip
          never goes out on two accounts at once: each next account follows at least its spacing later.
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
