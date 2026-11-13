import { type FormEvent, useEffect, useRef, useState } from "react";
import type { CampaignDraft, CampaignField, CampaignRules, NewSourceInput, PermissionKind, Platform, Source } from "../../shared/types";
import {
  ALLOWANCE_VALID_DAYS,
  CAMPAIGN_FIELDS,
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
  /** Set when a campaign link was read: the form starts from what the page says, as a Whop campaign. */
  draft?: CampaignDraft;
  onClose: () => void;
  onSaved: () => void;
}

function numberOrNull(s: string): number | null {
  return s.trim() === "" ? null : Number(s);
}

function split(s: string, by: RegExp): string[] {
  return s.split(by).map((x) => x.trim()).filter(Boolean);
}

/** "Add a campaign" (or a permission for one creator): a sheet over the page, closed with × or Escape. */
export function CampaignForm({ source, draft, onClose, onSaved }: Props) {
  const [kind, setKind] = useState<PermissionKind>("whop-campaign");
  const [platforms, setPlatforms] = useState<Platform[]>(draft ? draft.allowedPlatforms : ["tiktok", "youtube", "instagram"]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstField = useRef<HTMLSelectElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (firstField.current ?? sheet.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "");
    const expires = text("expiresAt");
    const rules: CampaignRules = {
      requiredTags: split(text("requiredTags"), /[\s,]+/),
      requiredLinks: split(text("requiredLinks"), /\s+/),
      requiredText: split(text("requiredText"), /\n+/),
      bannedWords: split(text("bannedWords"), /[,\n]+/),
      minSec: numberOrNull(text("minSec")),
      maxSec: numberOrNull(text("maxSec")),
      budgetLeftUsd: numberOrNull(text("budgetLeftUsd")),
    };
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
        rules: kind === "whop-campaign" ? rules : null,
      },
    };
    setSaving(true);
    setError(null);
    try {
      if (source) await api.addPermission(source.id, input.permission);
      // A campaign read from its link goes onto its creator: made new, or brought up to date.
      else if (draft) await api.saveCampaign(input);
      else await api.addSource(input);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const experiment = kind === "experiment";
  const r = draft?.rules;
  /** Next to a field the page did not give: empty on purpose, for the manager to look at. */
  const check = (...fields: CampaignField[]) =>
    draft && fields.every((f) => draft.check.includes(f)) ? <span className="check-this">check this</span> : null;
  const missing = draft?.check.length ?? 0;
  const togglePlatform = (p: Platform) =>
    setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  return (
    <div className="scrim" onClick={onClose}>
      <div
        ref={sheet}
        tabIndex={-1}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="campaign-form-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2 id="campaign-form-title">{source ? `Add a permission for ${source.creatorName}` : draft ? "Add this campaign" : "Add a campaign"}</h2>
          <button type="button" className="close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <form onSubmit={submit} className="form">
          {draft?.ended && (
            <p className="error" role="alert">
              {draft.ended} Adding it would not let you post: look for a campaign that is still running.
            </p>
          )}
          {draft && (
            <p className="hint" role="status" data-testid="draft-note">
              {missing === 0
                ? "Everything below was read from the campaign page. Have a look, then add it."
                : missing === CAMPAIGN_FIELDS.length
                  ? "Nothing could be read from the page, so every field is yours to fill in."
                  : `Read from the campaign page. ${missing} ${missing === 1 ? "thing was" : "things were"} not on it: ${missing === 1 ? "it is" : "they are"} left empty and marked “check this”. Nothing is guessed.`}
              {draft.existingSource && ` This campaign will be saved to ${draft.existingSource}, who is already in Sources.`}
            </p>
          )}
          {/* The select sits beside its label, not inside it: an option's words ("Creator publicly…") are not the label. */}
          {!draft && (
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
          )}
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
              <input
                name="campaignUrl"
                type="url"
                inputMode="url"
                placeholder="https://whop.com/…"
                required={kind === "whop-campaign"}
                defaultValue={draft?.campaignUrl}
              />
            </label>
          )}
          {!source && (
            <>
              <label>
                Creator {check("creatorName")}
                <input name="creatorName" required autoComplete="off" placeholder="Their streamer name" defaultValue={draft?.creatorName ?? ""} />
              </label>
              <label>
                Channel links <span className="hint">one per line</span> {check("channelUrls")}
                <textarea name="channelUrls" rows={2} placeholder="https://www.twitch.tv/…" defaultValue={draft?.channelUrls.join("\n")} />
              </label>
            </>
          )}
          {kind !== "public-allowance" && !experiment && (
            <div className="row">
              <label>
                Pay per 1,000 views ($) {check("cpmRateUsd")}
                <input name="cpmRateUsd" type="number" min="0" step="0.01" inputMode="decimal" defaultValue={draft?.cpmRateUsd ?? ""} />
              </label>
              <label>
                Minimum views {check("minViews")}
                <input name="minViews" type="number" min="0" step="1" inputMode="numeric" defaultValue={draft?.minViews ?? ""} />
              </label>
            </div>
          )}
          <fieldset>
            <legend>Where clips may be posted {check("allowedPlatforms")}</legend>
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
            </span>{" "}
            {check("expiresAt")}
            <input name="expiresAt" type="date" defaultValue={draft?.expiresAt?.slice(0, 10)} />
          </label>
          {kind === "whop-campaign" && (
            <fieldset className="campaign-rules">
              <legend>Campaign rules</legend>
              <p className="hint">
                Checked before every post: a clip that breaks one is not posted under this campaign, and you are told why. Required tags,
                links and words are added to the caption for you.
              </p>
              <label>
                Tags the caption must carry <span className="hint">like #ad @creator</span> {check("requiredTags")}
                <input name="requiredTags" autoComplete="off" autoCapitalize="none" defaultValue={r?.requiredTags.join(" ")} />
              </label>
              <label>
                Links the caption must carry <span className="hint">one per line</span> {check("requiredLinks")}
                <textarea name="requiredLinks" rows={2} inputMode="url" defaultValue={r?.requiredLinks.join("\n")} />
              </label>
              <label>
                Words the caption must say <span className="hint">one per line</span> {check("requiredText")}
                <textarea name="requiredText" rows={2} defaultValue={r?.requiredText.join("\n")} />
              </label>
              <label>
                Banned words and topics <span className="hint">separated by commas</span> {check("bannedWords")}
                <textarea name="bannedWords" rows={2} defaultValue={r?.bannedWords.join(", ")} />
              </label>
              <div className="row">
                <label>
                  Shortest clip (s) {check("clipLength")}
                  <input name="minSec" type="number" min="0" step="1" inputMode="numeric" defaultValue={r?.minSec ?? ""} />
                </label>
                <label>
                  Longest clip (s) {check("clipLength")}
                  <input name="maxSec" type="number" min="0" step="1" inputMode="numeric" defaultValue={r?.maxSec ?? ""} />
                </label>
              </div>
              <label>
                Budget left ($) <span className="hint">if the page shows it</span> {check("budgetLeftUsd")}
                <input name="budgetLeftUsd" type="number" min="0" step="0.01" inputMode="decimal" defaultValue={r?.budgetLeftUsd ?? ""} />
              </label>
            </fieldset>
          )}
          {!experiment && (
            <label>
              Brief rules
              <textarea
                name="briefRules"
                rows={4}
                placeholder={kind === "public-allowance" ? "Their conditions: credit me, no TikTok…" : "Paste the campaign brief: length, credit, hashtags…"}
                defaultValue={draft?.briefRules}
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
            {saving ? "Saving…" : source ? "Save permission" : draft ? "Add campaign" : "Save campaign"}
          </button>
        </form>
      </div>
    </div>
  );
}
