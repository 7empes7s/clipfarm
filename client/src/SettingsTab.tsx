import { SubmitHoursCard } from "./SubmitWindow";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import type { IntegrationId, IntegrationStatus, SettingField, SettingsInfo } from "../../shared/types";
import { TemplatesSettings } from "./TemplatesSettings";
import { AccountsSettings } from "./AccountsSettings";
import { api } from "./api";
import { shortDate } from "./format";
import { AutoModeCard } from "./ScoutCard";
import { Sheet } from "./Sheet";
import { saveTheme, savedTheme, THEME_LABELS, THEMES } from "./theme";
import { Skeleton } from "./ui";

/** Where each key comes from: short numbered steps, with the exact values to type on the other site. */
const STEPS: Record<IntegrationId, { title: string; steps: ReactNode[] }> = {
  openai: {
    title: "How to get an OpenAI key",
    steps: [
      <>
        Open <Out href="https://platform.openai.com/api-keys">platform.openai.com/api-keys</Out> and sign in.
      </>,
      <>
        Tap <b>Create new secret key</b>. Name: <code>clipfarm</code>.
      </>,
      <>Copy the key (it is shown only once) and paste it here.</>,
      <>
        Under <b>Billing</b>, add a few dollars of credit. One hour of stream costs about $0.40 to transcribe.
      </>,
    ],
  },
  google: {
    title: "How to connect Google (Gemini)",
    steps: [
      <>
        Open <Out href="https://console.cloud.google.com/">console.cloud.google.com</Out>, signed in as the account that has the
        credit. Copy the <b>Project ID</b> from the project picker at the top.
      </>,
      <>
        Go to <b>APIs and services</b>, then <b>Library</b>. Find <code>Vertex AI API</code> and tap <b>Enable</b>.
      </>,
      <>
        Go to <b>IAM and admin</b>, then <b>Service accounts</b>. Tap <b>Create service account</b>. Name: <code>clipfarm</code>. Role:{" "}
        <code>Vertex AI User</code>.
      </>,
      <>
        Open the new account, then <b>Keys</b>, <b>Add key</b>, <b>Create new key</b>, <b>JSON</b>. A file is downloaded. Open it, copy
        everything in it and paste it here as the service account JSON. (An API key from <b>Credentials</b> works too.)
      </>,
      <>
        Tap <b>Test</b>. The spend and the daily limit are then on the Dashboard, under <b>Google credit</b>.
      </>,
    ],
  },
  twitch: {
    title: "How to make a Twitch app",
    steps: [
      <>
        Open <Out href="https://dev.twitch.tv/console/apps">dev.twitch.tv/console/apps</Out> and sign in. Twitch asks for
        two-step sign-in to be on.
      </>,
      <>
        Tap <b>Register Your Application</b>. Name: <code>clipfarm watchlist</code> (any name nobody else uses).
      </>,
      <>
        OAuth Redirect URL: <code>https://clip.techinsiderbytes.com/auth/twitch</code> (Twitch refuses http).
      </>,
      <>
        Category: <code>Website Integration</code>. Client type: <code>Confidential</code>. Tap <b>Create</b>.
      </>,
      <>
        Tap <b>Manage</b> on the new app. Copy the <b>Client ID</b>, then tap <b>New Secret</b> and copy the secret. Paste
        both here.
      </>,
    ],
  },
  youtube: {
    title: "How to get a YouTube key",
    steps: [
      <>
        Open <Out href="https://console.cloud.google.com/projectcreate">console.cloud.google.com</Out> and make a project
        called <code>clipfarm</code>.
      </>,
      <>
        Go to <b>APIs and services</b>, then <b>Library</b>. Find <code>YouTube Data API v3</code> and tap <b>Enable</b>.
      </>,
      <>
        Go to <b>Credentials</b>, tap <b>Create credentials</b>, then <b>API key</b>.
      </>,
      <>
        Under <b>API restrictions</b>, limit the key to <code>YouTube Data API v3</code>. Copy the key and paste it here.
      </>,
    ],
  },
  postiz: {
    title: "How to link accounts in Postiz",
    steps: [
      <>Open Postiz and sign in.</>,
      <>
        Tap <b>Add Channel</b> and link each account clips should go to: YouTube, TikTok, Instagram.
      </>,
      <>
        Go to <b>Settings</b>, then <b>Public API</b>, and copy the API key.
      </>,
      <>
        Paste the key here. Postiz address: <code>http://127.0.0.1:5300</code> (Postiz runs on the same server).
      </>,
      <>
        Tap <b>Test</b>: it says how many accounts are linked.
      </>,
    ],
  },
  "upload-post": {
    title: "How to set up Upload-Post",
    steps: [
      <>
        Open <Out href="https://app.upload-post.com">app.upload-post.com</Out> and sign in.
      </>,
      <>Make a profile and link the accounts clips should go to. Its name is the profile name asked for here.</>,
      <>
        Go to <b>API Keys</b>, make a key and copy it. Paste the key and the profile name here.
      </>,
    ],
  },
  stripe: {
    title: "How to set up Stripe",
    steps: [
      <>
        Open <Out href="https://dashboard.stripe.com/apikeys">dashboard.stripe.com/apikeys</Out> and copy the <b>Secret key</b> (a test key first, to try it).
      </>,
      <>Paste it here and tap <b>Test</b>.</>,
      <>
        Ask IT to run the Stripe setup (<code>npm run ops -- stripe-setup</code>): it makes the plans' prices, the VAT settings and the webhook. Nothing else to do in Stripe.
      </>,
    ],
  },
  "client-signin": {
    title: "How to set up client sign-in",
    steps: [
      <>
        Open <Out href="https://resend.com/api-keys">resend.com/api-keys</Out>, make a key with sending access, and paste it here with the address emails come from.
      </>,
      <>
        Optional, for "Sign in with Google": in Google Cloud, make an OAuth client (Web application) with the redirect address <code>/portal/auth/google/callback</code> on this site, and paste its ID and secret.
      </>,
    ],
  },
};

function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const SOURCE_LABEL = { settings: "from Settings", env: "from server env" } as const;

/** Where the value in use comes from: "from Settings, saved 12 Nov", "from server env" or "the default". */
function sourceLine(f: SettingField): string {
  if (!f.set) return "the default";
  const saved = f.source === "settings" && f.savedAt ? `, saved ${shortDate(f.savedAt)}` : "";
  return `${SOURCE_LABEL[f.source!]}${saved}`;
}

function fieldLine(f: SettingField): string {
  if (!f.set) return f.fallback ? `${f.fallback} (the default)` : f.required ? "Not set" : "Not set (optional)";
  const what = f.secret ? (f.ending ? `Set, ends in …${f.ending}` : "Set") : f.value!;
  return `${what} (${sourceLine(f)})`;
}

/** A dropdown's choices: the service's list, plus the value in use when the list does not have it. */
function choices(f: SettingField): string[] {
  const inUse = f.value ?? f.fallback;
  return inUse && !f.options!.includes(inUse) ? [inUse, ...f.options!] : f.options!;
}

const choiceLabel = (f: SettingField, id: string) => (id === f.fallback ? `${id} (recommended)` : id);
const shortLabel = (f: SettingField) => f.label.replace(/ \(optional.*\)$/, "");

function stateOf(row: IntegrationStatus): { label: string; className: string } {
  if (!row.configured) return { label: "Not set", className: "state state-idle" };
  if (!row.test) return { label: "Not tested", className: "state state-idle" };
  return row.test.ok ? { label: "Working", className: "state state-active" } : { label: "Failed", className: "state state-none" };
}

/** Settings: every key and connection, pasted once, tested, and in use at once. */
export function SettingsTab({ focus }: { focus: string | undefined }) {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<IntegrationId | null>(null);

  useEffect(() => {
    let on = true;
    api.settings().then(
      (s) => on && setInfo(s),
      (err: Error) => on && setError(err.message),
    );
    return () => {
      on = false;
    };
  }, []);

  // "#settings/twitch" (from the watchlist or the setup list) lands on that row.
  const loaded = info !== null;
  useEffect(() => {
    if (loaded && focus) document.getElementById(`settings-${focus}`)?.scrollIntoView({ block: "start" });
  }, [loaded, focus]);

  const [theme, setTheme] = useState(savedTheme);
  const closeSheet = useCallback(() => setEditing(null), []);
  const editingRow = info?.integrations.find((i) => i.id === editing);

  return (
    <section aria-labelledby="settings-title" className="settings">
      <div className="section-head">
        <h2 id="settings-title">Keys and connections</h2>
        <a href="#dashboard">Back to dashboard</a>
      </div>
      <p className="hint">
        Paste each key once, then tap Test (OpenAI is tested as it is saved). A saved key is used right away. Keys are kept on the server and never shown again:
        only their last 4 characters.
      </p>
      {info?.demo && (
        <p className="hint">Demo mode is on: keys are saved, but every outside service is a stand-in, so Test calls nothing.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!info && !error && <Skeleton shape="card" count={3} />}
      {info && (
        <ul className="stack">
          {info.integrations.map((row) => (
            <Row key={row.id} row={row} open={focus === row.id} onInfo={setInfo} onEdit={() => setEditing(row.id)} />
          ))}
        </ul>
      )}
      <AccountsSettings focus={focus === "accounts"} />
      <TemplatesSettings focus={focus === "templates"} />
      <AutoModeCard />
      <SubmitHoursCard />
      <div className="card look" data-testid="settings-look">
        <h3 id="look-title">Look</h3>
        <div className="chips" role="radiogroup" aria-labelledby="look-title">
          {THEMES.map((t) => (
            <label key={t} className="chip">
              <input
                type="radio"
                name="theme"
                checked={theme === t}
                onChange={() => {
                  saveTheme(t);
                  setTheme(t);
                }}
              />
              {THEME_LABELS[t]}
            </label>
          ))}
        </div>
      </div>
      {editingRow && (
        <KeysSheet
          row={editingRow}
          onClose={closeSheet}
          onSaved={(next) => {
            setInfo(next);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function Row({
  row,
  open,
  onInfo,
  onEdit,
}: {
  row: IntegrationStatus;
  open: boolean;
  onInfo: (info: SettingsInfo) => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState<"test" | "remove" | "choose" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = stateOf(row);
  const saved = row.fields.some((f) => f.source === "settings");
  const anySet = row.fields.some((f) => f.set);

  async function run(what: "test" | "remove") {
    setBusy(what);
    setError(null);
    try {
      onInfo(what === "test" ? (await api.testSettings(row.id)).settings : await api.removeSettings(row.id));
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // A model picked from the list is saved at once, and the server tests it before it answers.
  async function choose(name: string, value: string) {
    setBusy("choose");
    setError(null);
    try {
      onInfo(await api.saveSettings(row.id, { [name]: value }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="card" id={`settings-${row.id}`} data-testid={`settings-${row.id}`}>
      <div className="card-head">
        <h3>{row.label}</h3>
        <span className={state.className}>{state.label}</span>
      </div>
      <p className="hint key-purpose">{row.purpose}</p>
      <dl className="key-fields">
        {row.fields
          .filter((f) => f.required || f.set || f.fallback)
          .map((f) => (
            <div key={f.name}>
              <dt>{shortLabel(f)}</dt>
              {f.options && row.configured ? (
                <dd className="key-choice">
                  <select
                    aria-label={shortLabel(f)}
                    value={f.value ?? f.fallback ?? ""}
                    disabled={busy !== null}
                    onChange={(e) => void choose(f.name, e.target.value)}
                  >
                    {choices(f).map((id) => (
                      <option key={id} value={id}>
                        {choiceLabel(f, id)}
                      </option>
                    ))}
                  </select>
                  <span className="hint">{busy === "choose" ? "Saving and testing…" : sourceLine(f)}</span>
                </dd>
              ) : (
                <dd>{fieldLine(f)}</dd>
              )}
            </div>
          ))}
      </dl>
      {row.note && <p className="hint">{row.note}</p>}
      {row.test && (
        <p className={row.test.ok ? "key-result key-ok" : "key-result key-bad"} role="status">
          {row.test.message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirming ? (
        <div className="actions key-actions">
          <span className="key-confirm">Remove the saved {row.label} keys?</span>
          <button type="button" className="danger" disabled={busy !== null} onClick={() => void run("remove")}>
            {busy === "remove" ? "Removing…" : "Yes, remove"}
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </div>
      ) : (
        <div className="actions key-actions">
          <button type="button" className={anySet ? undefined : "primary"} onClick={onEdit}>
            {anySet ? "Replace" : "Paste keys"}
          </button>
          <button type="button" disabled={!row.configured || busy !== null} onClick={() => void run("test")}>
            {busy === "test" ? "Testing…" : "Test"}
          </button>
          {saved && (
            <button type="button" className="link" onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </div>
      )}
      <details className="key-steps" open={open || undefined}>
        <summary>{STEPS[row.id].title}</summary>
        <ol>
          {STEPS[row.id].steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </details>
    </li>
  );
}

function KeysSheet({ row, onClose, onSaved }: { row: IntegrationStatus; onClose: () => void; onSaved: (info: SettingsInfo) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const values = Object.fromEntries(row.fields.map((f) => [f.name, String(form.get(f.name) ?? "")]));
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.saveSettings(row.id, values));
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <Sheet id="keys-sheet-title" title={`${row.label} keys`} onClose={onClose}>
      <form className="form" onSubmit={submit} autoComplete="off">
        {row.fields.map((f) => (
          <label key={f.name}>
            {f.label}
            {f.secret && f.set && <span className="hint"> leave empty to keep the one that is set</span>}
            {f.options ? (
              <select name={f.name} defaultValue={(f.source === "settings" ? f.value : null) ?? ""}>
                <option value="">{f.fallback ? `The default (${f.fallback})` : "Not set"}</option>
                {choices(f).map((id) => (
                  <option key={id} value={id}>
                    {choiceLabel(f, id)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name={f.name}
                // Keys are pasted, not typed: plain text so a bad paste is seen before saving. Nothing is prefilled.
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required={f.required && !f.set}
                placeholder={f.placeholder}
                defaultValue={f.secret ? "" : (f.source === "settings" ? f.value : null) ?? ""}
              />
            )}
          </label>
        ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {saving ? (row.id === "openai" ? "Saving and testing…" : "Saving…") : "Save"}
        </button>
      </form>
    </Sheet>
  );
}
