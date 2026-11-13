import { type FormEvent, useState } from "react";
import type { CampaignDraft } from "../../shared/types";
import { CAMPAIGN_FIELDS, NO_CAMPAIGN_RULES } from "../../shared/types";
import { api } from "./api";

/** A draft with nothing read: every field is the manager's to fill, each marked "check this". */
function emptyDraft(campaignUrl: string): CampaignDraft {
  return {
    campaignUrl,
    creatorName: null,
    channelUrls: [],
    cpmRateUsd: null,
    minViews: null,
    allowedPlatforms: [],
    expiresAt: null,
    briefRules: "",
    rules: NO_CAMPAIGN_RULES,
    check: [...CAMPAIGN_FIELDS],
    ended: null,
    existingSource: null,
  };
}

/**
 * "Paste a campaign link" on Sources: reads the campaign's public page and hands the form its
 * starting values. When the page cannot be read, its text can be pasted instead.
 */
export function CampaignImport({ onDraft }: { onDraft: (draft: CampaignDraft) => void }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the page could not be read: the paste box and "fill in by hand" appear.
  const [unread, setUnread] = useState(false);

  async function read(e: FormEvent) {
    e.preventDefault();
    setReading(true);
    setError(null);
    try {
      onDraft(await api.readCampaign(url.trim(), unread && text.trim() ? text : undefined));
      setUrl("");
      setText("");
      setUnread(false);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      setUnread(message.startsWith("The campaign page could not be read"));
    } finally {
      setReading(false);
    }
  }

  return (
    <form className="card campaign-import" onSubmit={read} data-testid="campaign-import">
      <label htmlFor="campaign-import-url">Paste a campaign link</label>
      <p className="hint">From whop.com or contentrewards.com. clipfarm reads the page and fills in the pay, the rules and the end date for you to check.</p>
      <div className="inline">
        <input
          id="campaign-import-url"
          type="url"
          inputMode="url"
          required
          placeholder="https://whop.com/…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" disabled={reading}>
          {reading ? "Reading…" : unread && text.trim() ? "Read the text" : "Read the page"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {unread && (
        <>
          <label htmlFor="campaign-import-text">The campaign page's text</label>
          <textarea
            id="campaign-import-text"
            rows={4}
            placeholder="Open the campaign, select everything on the page, copy it and paste it here"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="meta">
            <button type="button" className="link" onClick={() => onDraft(emptyDraft(url.trim()))}>
              Fill the form in by hand
            </button>
          </div>
        </>
      )}
    </form>
  );
}
