import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { DirectPlatform, IsolationGroup, IsolationInfo } from "../../shared/types";
import { ACCOUNT_ROLES, APP_KEY_LABELS, PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { Meter } from "./charts";
import { shortDate } from "./format";
import { Sheet } from "./Sheet";

const KIND_LABELS = { main: "Main accounts", burner: "Burner accounts" } as const;
const SHORT: Record<DirectPlatform, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };

type Editing = { group: IsolationGroup; what: "proxy" } | { group: IsolationGroup; what: "app"; platform: DirectPlatform } | { what: "group" };

/** The clock time of an instant on this device: "Fri 09:00". */
function localTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Settings, Accounts: isolation groups. Each group has its own developer app per platform and its
 * own way out to the internet, so a burner cannot be traced to a main channel through either.
 */
export function AccountsSettings({ focus }: { focus: boolean }) {
  const [info, setInfo] = useState<IsolationInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  // "?connect=ok" is how the browser comes back from a platform's sign-in page.
  const [cameBack] = useState(() => new URLSearchParams(window.location.search).get("connect"));

  useEffect(() => {
    let on = true;
    api.groups().then(
      (g) => on && setInfo(g),
      (err: Error) => on && setError(err.message),
    );
    return () => {
      on = false;
    };
  }, []);

  // The note is for this visit: a reload or a later visit to Settings does not repeat it.
  useEffect(() => {
    if (cameBack) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  }, [cameBack]);

  const loaded = info !== null;
  useEffect(() => {
    if (loaded && (focus || cameBack)) document.getElementById("settings-accounts")?.scrollIntoView({ block: "start" });
  }, [loaded, focus, cameBack]);

  const closeSheet = useCallback(() => setEditing(null), []);
  const saved = (next: IsolationInfo) => {
    setInfo(next);
    setEditing(null);
  };
  const connected = cameBack && info ? (info.lastConnect && info.lastConnect.ok === (cameBack === "ok") ? info.lastConnect : null) : null;

  return (
    <section aria-labelledby="settings-accounts" className="groups">
      <div className="section-head">
        <h2 id="settings-accounts">Accounts</h2>
      </div>
      <p className="hint">
        Platforms can link channels that upload through the same developer app or from the same internet address. Each group
        here has its own apps and its own way out, so a flag on a burner cannot reach a main channel. A burner posts only
        through a proxy that passed its test.
      </p>
      {info?.demo && <p className="hint">Demo mode is on: the platforms and the proxy test are stand-ins.</p>}
      {cameBack && info && (
        <p className={connected?.ok ? "key-result key-ok" : "key-result key-bad"} role="status" data-testid="connect-result">
          {connected?.message ?? "The sign-in did not come back as expected. Tap Connect channel again."}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!info && !error && <p className="hint">Loading…</p>}
      {info && (
        <>
          <ul className="stack">
            {info.groups.map((group) => (
              <GroupCard key={group.id} group={group} groups={info.groups} onInfo={setInfo} onEdit={setEditing} />
            ))}
          </ul>
          <div className="actions">
            <button type="button" onClick={() => setEditing({ what: "group" })}>
              Add a group
            </button>
          </div>
        </>
      )}
      {editing?.what === "proxy" && <ProxySheet group={editing.group} onClose={closeSheet} onSaved={saved} />}
      {editing?.what === "app" && <AppSheet group={editing.group} platform={editing.platform} onClose={closeSheet} onSaved={saved} />}
      {editing?.what === "group" && <GroupSheet onClose={closeSheet} onSaved={saved} />}
    </section>
  );
}

function GroupCard({
  group,
  groups,
  onInfo,
  onEdit,
}: {
  group: IsolationGroup;
  groups: IsolationGroup[];
  onInfo: (info: IsolationInfo) => void;
  onEdit: (editing: Editing) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { proxy, youtubeQuota: quota } = group;
  const others = groups.filter((g) => g.kind === group.kind && g.id !== group.id);

  async function run(what: string, action: () => Promise<IsolationInfo | void>) {
    setBusy(what);
    setError(null);
    try {
      const next = await action();
      if (next) onInfo(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const connect = (platform: DirectPlatform) =>
    run(`connect-${platform}`, async () => {
      // The platform's own sign-in page; it sends the browser back here when done.
      window.location.assign((await api.connectChannel(group.id, platform)).url);
    });

  return (
    <li className="card" data-testid={`group-${group.id}`}>
      <div className="card-head">
        <h3>{group.name}</h3>
        <span className={group.blocked ? "state state-none" : "state state-active"}>{group.blocked ? "Blocked" : "Ready"}</span>
      </div>
      <p className="hint key-purpose">
        {KIND_LABELS[group.kind]}. {group.kind === "burner" ? "A proxy is required." : "A proxy is optional."}
      </p>

      <div className={proxy.check?.ok ? "exit exit-ok" : "exit"} data-testid="exit">
        <span className="exit-label">Uploads leave from</span>
        <strong>
          {proxy.check?.ok
            ? `${proxy.check.exitIp}${proxy.check.country ? ` (${proxy.check.country})` : ""}`
            : proxy.set
              ? "not known yet"
              : group.kind === "burner"
                ? "nowhere: no proxy"
                : "this server's own address"}
        </strong>
        <span className="exit-via">
          {proxy.set ? `Proxy ${proxy.address}${proxy.signIn ? ", with a sign-in" : ""}` : "No proxy"}
          {proxy.check && `, tested ${shortDate(proxy.check.at)}`}
        </span>
      </div>
      {group.blocked && (
        <p className="key-result key-bad" role="status">
          {group.blocked}
        </p>
      )}
      <div className="actions key-actions">
        <button type="button" className={proxy.set || group.kind === "main" ? undefined : "primary"} onClick={() => onEdit({ group, what: "proxy" })}>
          {proxy.set ? "Replace proxy" : "Paste proxy"}
        </button>
        <button type="button" disabled={!proxy.set || busy !== null} onClick={() => void run("test", () => api.testGroupProxy(group.id))}>
          {busy === "test" ? "Testing…" : "Test"}
        </button>
        {proxy.set && (
          <button type="button" className="link" disabled={busy !== null} onClick={() => void run("remove-proxy", () => api.removeGroupProxy(group.id))}>
            Remove proxy
          </button>
        )}
      </div>

      <h4 className="group-part">Developer apps</h4>
      <ul className="group-rows">
        {group.apps.map((app) => (
          <li key={app.platform}>
            <div className="group-row-text">
              <span>{APP_KEY_LABELS[app.platform].app}</span>
              <span className="hint">{app.set ? (app.idEnding ? `Keys set, ID ends in …${app.idEnding}` : "Keys set") : "No keys yet"}</span>
            </div>
            <div className="actions">
              <button type="button" onClick={() => onEdit({ group, what: "app", platform: app.platform })} aria-label={`${app.set ? "Replace" : "Paste"} ${SHORT[app.platform]} keys`}>
                {app.set ? "Replace" : "Paste keys"}
              </button>
              <button
                type="button"
                className={app.set ? "primary" : undefined}
                disabled={!app.set || group.blocked !== null || busy !== null}
                onClick={() => void connect(app.platform)}
                aria-label={`Connect ${SHORT[app.platform]} channel`}
              >
                {busy === `connect-${app.platform}` ? "Opening…" : "Connect channel"}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h4 className="group-part">YouTube quota of this group's app</h4>
      <Meter value={quota.used / quota.limit} label={`YouTube units used today in ${group.name}`} />
      <p className="hint" data-testid="quota">
        {quota.used.toLocaleString("en-US")} of {quota.limit.toLocaleString("en-US")} units used today (an upload costs 1,600).
        {quota.fullUntil && ` Quota full until midnight Pacific time (${localTime(quota.fullUntil)} here): new uploads wait until then.`}
      </p>

      <h4 className="group-part">Accounts in this group</h4>
      {group.accounts.length === 0 ? (
        <p className="hint">None yet. Paste an app's keys above, then tap Connect channel.</p>
      ) : (
        <ul className="group-rows">
          {group.accounts.map((a) => (
            <li key={a.id}>
              <div className="group-row-text">
                <span>
                  {a.name}, {PLATFORM_LABELS[a.platform]}
                </span>
                <span className="hint">
                  {a.direct
                    ? a.disabled
                      ? "Its sign-in ran out: connect it again"
                      : "Connected here: uploads use this group's app and way out"
                    : group.kind === "burner"
                      ? "Linked in the posting service, which cannot use a proxy: connect it here to post"
                      : "Linked in the posting service: posts from this server"}
                </span>
              </div>
              {!a.direct && others.length > 0 && (
                <select
                  aria-label={`Group of ${a.name}`}
                  value={group.id}
                  disabled={busy !== null}
                  onChange={(e) => void run("move", () => api.moveAccount(a.id, Number(e.target.value)))}
                >
                  {[group, ...others].map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <details className="key-steps">
        <summary>What to paste where</summary>
        <ol>
          {group.kind === "burner" && (
            <li>
              Buy one residential or ISP proxy with a fixed address, from any provider. It gives you a host, a port, a user name
              and a password. Paste them as <code>http://user:password@host:port</code> (or <code>socks5://…</code>), then tap{" "}
              <b>Test</b>.
            </li>
          )}
          <li>
            Use a separate Google account for this group. In its Google Cloud project, turn on <code>YouTube Data API v3</code>{" "}
            and make an OAuth client of type <b>Web application</b>. Redirect URI: <code>{group.apps[0]!.redirectUri}</code>
          </li>
          <li>
            TikTok developer app with <b>Login Kit</b> and <b>Content Posting API</b> (Direct Post). Redirect URI:{" "}
            <code>{group.apps[1]!.redirectUri}</code>
          </li>
          <li>
            Meta app with <b>Facebook Login</b> and Instagram content publishing. Redirect URI: <code>{group.apps[2]!.redirectUri}</code>
          </li>
          <li>
            Paste each app's keys here, then tap <b>Connect channel</b> and sign in as the channel. Never reuse an app or a
            Google account between groups.
          </li>
        </ol>
      </details>
      {!group.builtIn && (
        <div className="actions">
          <button type="button" className="link" disabled={busy !== null} onClick={() => void run("remove", () => api.removeGroup(group.id))}>
            Remove this group
          </button>
        </div>
      )}
    </li>
  );
}

function useSave(onSaved: (info: IsolationInfo) => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(action: () => Promise<IsolationInfo>) {
    setSaving(true);
    setError(null);
    try {
      onSaved(await action());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return { saving, error, save };
}

/** Pasted values are plain text, never prefilled: what is saved is not sent back to the screen. */
const PASTE = { type: "text", autoComplete: "off", autoCapitalize: "none", autoCorrect: "off", spellCheck: false, required: true } as const;

function SaveButton({ saving, error }: { saving: boolean; error: string | null }) {
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </>
  );
}

function ProxySheet({ group, onClose, onSaved }: { group: IsolationGroup; onClose: () => void; onSaved: (info: IsolationInfo) => void }) {
  const { saving, error, save } = useSave(onSaved);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const url = String(new FormData(e.currentTarget).get("url") ?? "");
    void save(() => api.saveGroupProxy(group.id, url));
  }
  return (
    <Sheet id="proxy-sheet-title" title={`Proxy for ${group.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit} autoComplete="off">
        <label>
          Proxy address
          <span className="hint"> starts with http://, https:// or socks5://. Kept on the server and never shown again.</span>
          <input name="url" {...PASTE} placeholder="http://user:password@host:8080" />
        </label>
        <SaveButton saving={saving} error={error} />
      </form>
    </Sheet>
  );
}

function AppSheet({
  group,
  platform,
  onClose,
  onSaved,
}: {
  group: IsolationGroup;
  platform: DirectPlatform;
  onClose: () => void;
  onSaved: (info: IsolationInfo) => void;
}) {
  const { saving, error, save } = useSave(onSaved);
  const labels = APP_KEY_LABELS[platform];
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void save(() => api.saveGroupApp(group.id, platform, { id: String(form.get("id") ?? ""), secret: String(form.get("secret") ?? "") }));
  }
  return (
    <Sheet id="app-sheet-title" title={`${SHORT[platform]} keys for ${group.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit} autoComplete="off">
        <label>
          {labels.id}
          <input name="id" {...PASTE} placeholder="Paste it here" />
        </label>
        <label>
          {labels.secret}
          <input name="secret" {...PASTE} placeholder="Paste it here" />
        </label>
        <p className="hint">
          Redirect URI to paste in the app: <code>{group.apps.find((a) => a.platform === platform)!.redirectUri}</code>
        </p>
        <SaveButton saving={saving} error={error} />
      </form>
    </Sheet>
  );
}

function GroupSheet({ onClose, onSaved }: { onClose: () => void; onSaved: (info: IsolationInfo) => void }) {
  const { saving, error, save } = useSave(onSaved);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void save(() => api.addGroup(String(form.get("name") ?? ""), String(form.get("kind") ?? "")));
  }
  return (
    <Sheet id="group-sheet-title" title="Add a group" onClose={onClose}>
      <form className="form" onSubmit={submit} autoComplete="off">
        <label>
          Name
          <input name="name" type="text" required maxLength={40} placeholder="Whop channels" />
        </label>
        <fieldset>
          <legend>Who it is for</legend>
          {ACCOUNT_ROLES.map((kind) => (
            <label key={kind} className="chip">
              <input type="radio" name="kind" value={kind} defaultChecked={kind === "main"} />
              {KIND_LABELS[kind]}
            </label>
          ))}
          <p className="hint">Main and burner accounts never share a group. A burner group needs a proxy before it can post.</p>
        </fieldset>
        <SaveButton saving={saving} error={error} />
      </form>
    </Sheet>
  );
}
