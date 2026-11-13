import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import type { IntegrationId, IntegrationStatus, SettingField, SettingsInfo } from "../../shared/types";
import { AccountsSettings } from "./AccountsSettings";
import { api } from "./api";
import { shortDate } from "./format";
import { Sheet } from "./Sheet";

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
};

function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

const SOURCE_LABEL = { settings: "from Settings", env: "from server env" } as const;

function fieldLine(f: SettingField): string {
  if (!f.set) return f.required ? "Not set" : "Not set (optional)";
  const what = f.secret ? (f.ending ? `Set, ends in …${f.ending}` : "Set") : f.value!;
  const saved = f.source === "settings" && f.savedAt ? `, saved ${shortDate(f.savedAt)}` : "";
  return `${what} (${SOURCE_LABEL[f.source!]}${saved})`;
}

function stateOf(row: IntegrationStatus): { label: string; className: string } {
  if (!row.configured) return { label: "Not set", className: "state state-idle" };
  if (!row.test) return { label: "Not tested", className: "state state-idle" };
  return row.test.ok ? { label: "Works", className: "state state-active" } : { label: "Test failed", className: "state state-none" };
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

  const closeSheet = useCallback(() => setEditing(null), []);
  const editingRow = info?.integrations.find((i) => i.id === editing);

  return (
    <section aria-labelledby="settings-title" className="settings">
      <div className="section-head">
        <h2 id="settings-title">Keys and connections</h2>
        <a href="#dashboard">Back to dashboard</a>
      </div>
      <p className="hint">
        Paste each key once, then tap Test. A saved key is used right away. Keys are kept on the server and never shown again:
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
      {!info && !error && <p className="hint">Loading…</p>}
      {info && (
        <ul className="stack">
          {info.integrations.map((row) => (
            <Row key={row.id} row={row} open={focus === row.id} onInfo={setInfo} onEdit={() => setEditing(row.id)} />
          ))}
        </ul>
      )}
      <AccountsSettings focus={focus === "accounts"} />
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
  const [busy, setBusy] = useState<"test" | "remove" | null>(null);
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

  return (
    <li className="card" id={`settings-${row.id}`} data-testid={`settings-${row.id}`}>
      <div className="card-head">
        <h3>{row.label}</h3>
        <span className={state.className}>{state.label}</span>
      </div>
      <p className="hint key-purpose">{row.purpose}</p>
      <dl className="key-fields">
        {row.fields
          .filter((f) => f.required || f.set)
          .map((f) => (
            <div key={f.name}>
              <dt>{f.label.replace(/ \(optional.*\)$/, "")}</dt>
              <dd>{fieldLine(f)}</dd>
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
          </label>
        ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
    </Sheet>
  );
}
