import { useEffect, useState } from "react";
import type { Clip, ExportPack, Platform } from "../../shared/types";
import { PERMISSION_KIND_LABELS, PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";

/** The export pack: MP4 + caption (credit, the brief's links and hashtags) to post by hand. */
export function ExportSheet({ clip, platforms, onClose }: { clip: Clip; platforms: Platform[]; onClose: () => void }) {
  const [platform, setPlatform] = useState<Platform | undefined>(platforms[0]);
  const [pack, setPack] = useState<ExportPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!platform) return;
    let live = true;
    api.exportPack(clip.id, platform).then(
      (p) => live && (setPack(p), setError(null)),
      (err: Error) => live && (setPack(null), setError(err.message)),
    );
    return () => {
      live = false;
    };
  }, [clip.id, platform]);

  async function copyCaption() {
    if (!pack) return;
    try {
      await navigator.clipboard.writeText(pack.caption);
      setStatus("Caption copied.");
    } catch {
      setStatus("Could not copy here. Select the caption and copy it.");
    }
  }

  async function share() {
    if (!pack) return;
    try {
      const blob = await (await fetch(pack.videoUrl)).blob();
      const file = new File([blob], pack.fileName, { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: pack.caption });
        setStatus("Shared.");
        return;
      }
      await navigator.clipboard.writeText(pack.caption).catch(() => undefined);
      setStatus("This device can't share videos from the browser. Caption copied: download the MP4 and post it in the app.");
    } catch (err) {
      if ((err as Error).name !== "AbortError") setStatus("Sharing did not work. Download the MP4 instead.");
    }
  }

  return (
    <Sheet id="export-sheet-title" title="Export to post by hand" onClose={onClose}>
      <div className="form">
        {platforms.length === 0 ? (
          <p className="empty">This campaign has no platform it allows right now.</p>
        ) : (
          <label>
            For
            <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              {platforms.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {pack && (
          <>
            <label>
              Caption
              <textarea readOnly rows={6} value={pack.caption} data-testid="export-caption" />
            </label>
            {pack.permission.proofUrl && (
              <p className="proof" data-testid="export-proof">
                {PERMISSION_KIND_LABELS[pack.permission.kind]}: “{pack.permission.proofQuote}”{" "}
                <a href={pack.permission.proofUrl} target="_blank" rel="noreferrer">
                  See the proof
                </a>
              </p>
            )}
            <div className="actions">
              <a className="button" href={pack.videoUrl} download={pack.fileName}>
                Download MP4
              </a>
              <button type="button" onClick={() => void copyCaption()}>
                Copy caption
              </button>
              <button type="button" className="primary" onClick={() => void share()}>
                Share
              </button>
            </div>
            {status && (
              <p className="hint" role="status">
                {status}
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
