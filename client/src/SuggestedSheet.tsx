import { useEffect, useState } from "react";
import type { SuggestedCreator } from "../../shared/types";
import { PLATFORM_LABELS, WATCH_PLATFORM_LABELS } from "../../shared/types";
import { channelUrl } from "../../shared/watchlist";
import { api } from "./api";
import { shortDate } from "./format";
import { Sheet } from "./Sheet";

/** "Add suggested creators": the starter list of creators who publicly allow clipping, each with its proof. */
export function SuggestedSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [list, setList] = useState<SuggestedCreator[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api.suggested().then(
      (l) => live && setList(l),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, []);

  const open = list?.filter((c) => !c.added) ?? [];
  const toggle = (name: string) => setPicked((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));

  async function add() {
    setSaving(true);
    setError(null);
    try {
      await api.addSuggested(picked);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <Sheet id="suggested-title" title="Add suggested creators" onClose={onClose}>
      <div className="form">
        <p className="hint">
          These creators say in public that clipping is allowed. Read the proof, then tick the ones to add. Their new GTA VI
          streams are then picked up on their own (switch that off per creator in Watchlist), and each proof is read again
          every week.
        </p>
        {list && list.length === 0 && <p className="empty">The suggested list is empty.</p>}
        {open.length > 1 && (
          <button type="button" className="link tick-all" onClick={() => setPicked(picked.length === open.length ? [] : open.map((c) => c.name))}>
            {picked.length === open.length ? "Untick all" : "Tick all"}
          </button>
        )}
        <ul className="suggested">
          {list?.map((c) => (
            <li key={c.name} data-testid="suggested">
              <label className="suggested-pick">
                <input type="checkbox" disabled={c.added} checked={c.added || picked.includes(c.name)} onChange={() => toggle(c.name)} />
                <strong>{c.name}</strong>
                {c.added && <span className="state state-active">Added</span>}
              </label>
              <div className="badges">
                {c.channels.map((ch) => (
                  <a key={ch.platform} className={`badge badge-${ch.platform}`} href={channelUrl(ch)} target="_blank" rel="noreferrer">
                    {WATCH_PLATFORM_LABELS[ch.platform]}
                  </a>
                ))}
              </div>
              {c.note && <p className="hint">{c.note}</p>}
              <blockquote className="proof">“{c.proofQuote}”</blockquote>
              <p className="meta">
                <a href={c.proofUrl} target="_blank" rel="noreferrer">
                  See the proof
                </a>
                <span>read on {shortDate(c.checkedOn)}</span>
              </p>
              {c.rules && <p className="hint">Their rules: {c.rules}</p>}
              <p className="hint">Post to: {c.allowedPlatforms.map((p) => PLATFORM_LABELS[p]).join(", ")}</p>
            </li>
          ))}
        </ul>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="primary" disabled={saving || picked.length === 0} onClick={() => void add()}>
          {saving ? "Adding…" : picked.length === 0 ? "Tick the creators to add" : `Add ${picked.length} creator${picked.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </Sheet>
  );
}
