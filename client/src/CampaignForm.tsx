import { type FormEvent, useEffect, useRef, useState } from "react";
import type { NewSourceInput, PermissionKind, Platform, Source } from "../../shared/types";
import {
  ALLOWANCE_VALID_DAYS,
  EXPERIMENT_DAYS,
  PERMISSION_KIND_LABELS,
  PERMISSION_KINDS,
  PLATFORM_LABELS,
  PLATFORMS,
} from "../../shared/types";
import { api } from "./api";

interface Props {
  /** Set to add a permission to a creator we already have; left out, the form adds a new creator. */
  source?: Source;
  onClose: () => void;
  onSaved: () => void;
}

function numberOrNull(s: string): number | null {
  return s.trim() === "" ? null : Number(s);
}

/** "Add a campaign" (or a permission for one creator): a sheet over the page, closed with × or Escape. */
export function CampaignForm({ source, onClose, onSaved }: Props) {
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
        note: text("note"),
        cpmRateUsd: numberOrNull(text("cpmRateUsd")),
        minViews: numberOrNull(text("minViews")),
        allowedPlatforms: platforms,
        // The campaign runs through the end of the chosen day.
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        proofUrl: text("proofUrl") || null,
        proofQuote: text("proofQuote") || null,
        proofCheckedAt: text("proofCheckedAt") || null,
      },
    };
    setSaving(true);
    setError(null);
    try {
      if (source) await api.addPermission(source.id, input.permission);
      else await api.addSource(input);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const experiment = kind === "experiment";
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
          <h2 id="campaign-form-title">{source ? `Add a permission for ${source.creatorName}` : "Add a campaign"}</h2>
          <button type="button" className="close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <form onSubmit={submit} className="form">
          {/* The select sits beside its label, not inside it: an option's words ("Creator publicly…") are not the label. */}
          <div className="field">
            <label htmlFor="campaign-kind">Permission</label>
            <select id="campaign-kind" ref={firstField} value={kind} onChange={(e) => setKind(e.target.value as PermissionKind)}>
              {PERMISSION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PERMISSION_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          {kind === "public-allowance" && (
            <>
              <label>
                Link to where they say it <span className="hint">channel panel, about page, post, Discord rule…</span>
                <input name="proofUrl" type="url" inputMode="url" placeholder="https://…" required />
              </label>
              <label>
                Their words <span className="hint">copy the sentence that allows clipping</span>
                <textarea name="proofQuote" rows={2} maxLength={300} required />
              </label>
              <label>
                Checked on <span className="hint">the day you read it</span>
                <input name="proofCheckedAt" type="date" required defaultValue={new Date().toLocaleDateString("en-CA")} />
              </label>
            </>
          )}
          {experiment && (
            <>
              <p className="hint">
                A test of what the platforms do to clips posted without the creator's permission. These clips go to burner
                accounts only: never to a main account, an export or Whop. Leaks, isolated cutscenes and ending spoilers stay
                off limits.
              </p>
              <label>
                What this tests
                <textarea name="note" rows={2} required maxLength={280} placeholder="Does TikTok remove a 20 s reaction clip?" />
              </label>
            </>
          )}
          {kind !== "own-content" && kind !== "public-allowance" && !experiment && (
            <label>
              {kind === "whop-campaign" ? "Whop campaign link" : "Link to the permission (email, doc…)"}
              <input name="campaignUrl" type="url" inputMode="url" placeholder="https://whop.com/…" required={kind === "whop-campaign"} />
            </label>
          )}
          {!source && (
            <>
              <label>
                Creator
                <input name="creatorName" required autoComplete="off" placeholder="Their streamer name" />
              </label>
              <label>
                Channel links <span className="hint">one per line</span>
                <textarea name="channelUrls" rows={2} placeholder="https://www.twitch.tv/…" />
              </label>
            </>
          )}
          {kind !== "public-allowance" && !experiment && (
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
          )}
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
            Ends on{" "}
            <span className="hint">
              {kind === "public-allowance"
                ? `leave empty: it ends ${ALLOWANCE_VALID_DAYS} days after the last check and is checked again every week`
                : experiment
                  ? `leave empty to end in ${EXPERIMENT_DAYS} days`
                  : "leave empty if it does not end"}
            </span>
            <input name="expiresAt" type="date" />
          </label>
          {!experiment && (
            <label>
              Brief rules
              <textarea
                name="briefRules"
                rows={4}
                placeholder={kind === "public-allowance" ? "Their conditions: credit me, no TikTok…" : "Paste the campaign brief: length, credit, hashtags…"}
              />
            </label>
          )}
          {!source && (
            <label>
              Off limits
              <textarea name="bannedContent" rows={2} placeholder="Topics or moments never to clip" />
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : source ? "Save permission" : "Save campaign"}
          </button>
        </form>
      </div>
    </div>
  );
}
