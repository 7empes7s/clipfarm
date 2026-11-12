import { type FormEvent, useEffect, useRef, useState } from "react";
import type { NewSourceInput, PermissionKind, Platform } from "../../shared/types";
import { PERMISSION_KIND_LABELS, PERMISSION_KINDS, PLATFORM_LABELS, PLATFORMS } from "../../shared/types";
import { api } from "./api";

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

function numberOrNull(s: string): number | null {
  return s.trim() === "" ? null : Number(s);
}

/** "Add a campaign": a sheet over the page, closed with × or Escape. */
export function CampaignForm({ onClose, onSaved }: Props) {
  const [kind, setKind] = useState<PermissionKind>("whop-campaign");
  const [platforms, setPlatforms] = useState<Platform[]>(["tiktok", "youtube", "instagram"]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstField = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    firstField.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "");
    const expires = text("expiresAt");
    const input: NewSourceInput = {
      creatorName: text("creatorName"),
      channelUrls: text("channelUrls").split(/\s+/).filter(Boolean),
      bannedContent: text("bannedContent"),
      permission: {
        kind,
        campaignUrl: text("campaignUrl") || null,
        briefRules: text("briefRules"),
        cpmRateUsd: numberOrNull(text("cpmRateUsd")),
        minViews: numberOrNull(text("minViews")),
        allowedPlatforms: platforms,
        // The campaign runs through the end of the chosen day.
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      },
    };
    setSaving(true);
    setError(null);
    try {
      await api.addSource(input);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const togglePlatform = (p: Platform) =>
    setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="campaign-form-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2 id="campaign-form-title">Add a campaign</h2>
          <button type="button" className="close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <form onSubmit={submit} className="form">
          <label>
            Permission
            <select ref={firstField} value={kind} onChange={(e) => setKind(e.target.value as PermissionKind)}>
              {PERMISSION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PERMISSION_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {kind !== "own-content" && (
            <label>
              {kind === "whop-campaign" ? "Whop campaign link" : "Link to the permission (email, doc…)"}
              <input name="campaignUrl" type="url" inputMode="url" placeholder="https://whop.com/…" required={kind === "whop-campaign"} />
            </label>
          )}
          <label>
            Creator
            <input name="creatorName" required autoComplete="off" placeholder="Their streamer name" />
          </label>
          <label>
            Channel links <span className="hint">one per line</span>
            <textarea name="channelUrls" rows={2} placeholder="https://www.twitch.tv/…" />
          </label>
          <div className="row">
            <label>
              Pay per 1,000 views ($)
              <input name="cpmRateUsd" type="number" min="0" step="0.01" inputMode="decimal" />
            </label>
            <label>
              Minimum views
              <input name="minViews" type="number" min="0" step="1" inputMode="numeric" />
            </label>
          </div>
          <fieldset>
            <legend>Where clips may be posted</legend>
            <div className="chips">
              {PLATFORMS.map((p) => (
                <label key={p} className="chip">
                  <input type="checkbox" checked={platforms.includes(p)} onChange={() => togglePlatform(p)} />
                  {PLATFORM_LABELS[p]}
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Ends on <span className="hint">leave empty if it does not end</span>
            <input name="expiresAt" type="date" />
          </label>
          <label>
            Brief rules
            <textarea name="briefRules" rows={4} placeholder="Paste the campaign brief: length, credit, hashtags…" />
          </label>
          <label>
            Off limits
            <textarea name="bannedContent" rows={2} placeholder="Topics or moments never to clip" />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save campaign"}
          </button>
        </form>
      </div>
    </div>
  );
}
