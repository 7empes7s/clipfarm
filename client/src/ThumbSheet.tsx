import { useEffect, useState } from "react";
import type { ClipThumbs } from "../../shared/google";
import type { Clip } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";

/** The thumbnail options of a clip: look, pick one, download it at either size. */
export function ThumbSheet({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const [state, setState] = useState<ClipThumbs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    api.clipThumbs(clip.id).then((s) => on && setState(s), (err: Error) => on && setError(err.message));
    return () => {
      on = false;
    };
  }, [clip.id]);

  // While they are being made, look again every 2 seconds.
  const making = state?.making === true;
  useEffect(() => {
    if (!making) return;
    const t = setInterval(() => void api.clipThumbs(clip.id).then(setState, () => undefined), 2000);
    return () => clearInterval(t);
  }, [making, clip.id]);

  const act = (work: Promise<ClipThumbs>) => {
    setBusy(true);
    setError(null);
    void work.then(setState, (err: Error) => setError(err.message)).finally(() => setBusy(false));
  };

  return (
    <Sheet id="thumb-sheet-title" title="Thumbnail" onClose={onClose}>
      <div className="form">
        <p className="hint">{clip.title}</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {state?.making && (
          <p className="hint" role="status" data-testid="thumbs-making">
            Making the options. This takes about a minute.
          </p>
        )}
        {state && state.thumbs.length === 0 && !state.making && (
          <p className="empty">
            {state.ai
              ? "No thumbnails yet. Gemini makes two options from a frame of the clip and its hook."
              : "No thumbnails yet. Google is not connected or is paused, so the option will be a frame of the clip."}
          </p>
        )}
        {state && state.thumbs.length > 0 && (
          <ul className="thumbs" data-testid="thumbs">
            {state.thumbs.map((t) => (
              <li key={t.id} className={t.chosen ? "thumb is-chosen" : "thumb"} data-testid="thumb">
                <img src={t.coverUrl} alt={`${t.label}, vertical cover`} loading="lazy" />
                <strong>{t.label}</strong>
                <button type="button" className={t.chosen ? undefined : "primary"} disabled={busy || t.chosen} onClick={() => act(api.chooseThumb(t.id))}>
                  {t.chosen ? "In use" : "Use this one"}
                </button>
                <a href={`${t.coverUrl}?download=1`} download>
                  Download 9:16 cover
                </a>
                <a href={`${t.wideUrl}?download=1`} download>
                  Download for YouTube (1280×720)
                </a>
              </li>
            ))}
          </ul>
        )}
        {state && !state.making && (
          <button type="button" className={state.thumbs.length === 0 ? "primary" : undefined} disabled={busy} onClick={() => act(api.makeThumbs(clip.id))}>
            {state.thumbs.length === 0 ? "Make thumbnails" : "Make new ones"}
          </button>
        )}
      </div>
    </Sheet>
  );
}
