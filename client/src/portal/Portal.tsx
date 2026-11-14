import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import type { Clip, Platform } from "../../../shared/types";
import { PLATFORM_LABELS } from "../../../shared/types";
import type { Invoice, Plan, PortalDashboard, PortalMe } from "../../../shared/service";
import { money, PLAN_KIND_LABELS, planPrice } from "../../../shared/service";
import { SLOT_STATUS_LABELS, type SlotStatus } from "../../../shared/publishing";
import { compact, duration, shortDate } from "../format";
import { EmptyState, Icon, type IconName, Logo, Skeleton } from "../ui";
import { portal, type PortalAccount, type PortalCalendarItem, PortalError, type PortalSource, type PortalVideo } from "./api";

const TABS = [
  { id: "home", label: "Dashboard", icon: "dashboard" },
  { id: "clips", label: "Clips", icon: "inbox" },
  { id: "sources", label: "Videos", icon: "sources" },
  { id: "channels", label: "Channels", icon: "posted" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "brand", label: "Brand", icon: "edit" },
  { id: "plans", label: "Plans", icon: "stats" },
  { id: "billing", label: "Billing", icon: "jobs" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];
type Tab = (typeof TABS)[number]["id"];

const tabFromHash = (): Tab => {
  const h = window.location.hash.slice(1);
  return (TABS.find((t) => t.id === h)?.id ?? "home") as Tab;
};

const PLAN_KEY = "clipfarm.portal.plan";
function remember(key: string, value: string | null): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Private windows may refuse: the plan is just not pre-picked.
  }
}
function recall(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

const SIGNIN_NOTES: Record<string, string> = {
  expired: "That sign-in link was used or is too old. Ask for a new one.",
  failed: "Google did not finish the sign-in. Try again.",
  "google-off": "Google sign-in is not open yet. Use your email.",
};

/** The client portal: phone first, the client's own workspace only. */
export function Portal() {
  const [me, setMe] = useState<PortalMe | null>(null);
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const params = new URLSearchParams(window.location.search);

  const load = useCallback(
    () =>
      portal.me().then(
        (m) => {
          setMe(m);
          setState(m ? "ready" : "signed-out");
        },
        (err: Error) => {
          if (err instanceof PortalError && err.status === 401) setState("signed-out");
          else {
            setError(err.message);
            setState("error");
          }
        },
      ),
    [],
  );

  useEffect(() => {
    const plan = new URLSearchParams(window.location.search).get("plan");
    if (plan) remember(PLAN_KEY, plan);
    void load();
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [load]);

  if (state === "loading") {
    return (
      <main className="page">
        <Skeleton shape="tiles" />
      </main>
    );
  }
  if (state === "error") {
    return (
      <main className="page">
        <p className="error" role="alert">
          Could not reach clipfarm: {error}
        </p>
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );
  }
  if (state === "signed-out" || !me) return <SignIn note={SIGNIN_NOTES[params.get("signin") ?? ""] ?? null} />;

  const go = (t: Tab) => {
    window.location.hash = t;
  };
  const checkout = params.get("checkout");

  return (
    <div className="shell portal">
      <div className="side">
        <header className="appbar">
          <a className="brand" href="/service">
            <Logo />
            clipfarm
          </a>
          <button
            type="button"
            className="link"
            onClick={async () => {
              await portal.signOut().catch(() => undefined);
              window.location.href = "/portal";
            }}
          >
            Sign out
          </button>
        </header>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
              <Icon name={t.icon} />
              {t.label}
            </a>
          ))}
        </nav>
        <p className="tagline">{me.workspace.name}</p>
      </div>

      <main className="page">
        {me.readOnly && (
          <p className="pt-banner" role="status">
            Support view of {me.client.email}: read-only, nothing can be changed.
          </p>
        )}
        {me.demo && (
          <p className="pt-banner pt-demo" role="status">
            Demo mode: payments, email and Google are stand-ins. Nothing is charged.
          </p>
        )}
        {checkout === "done" && (
          <p className="pt-banner pt-ok" role="status">
            Thank you, your plan is on. Add a video to start.
          </p>
        )}
        {me.blocked && tab !== "plans" && tab !== "billing" && (
          <div className="pt-banner pt-warn" role="alert">
            <span>{me.blocked}</span>
            <button type="button" className="primary" onClick={() => go(me.client.status === "past_due" || me.client.status === "unpaid" ? "billing" : "plans")}>
              {me.client.status === "past_due" || me.client.status === "unpaid" ? "Update card" : me.plan ? "Upgrade" : "See plans"}
            </button>
          </div>
        )}

        {tab === "home" && <Home me={me} />}
        {tab === "clips" && <ClipsView me={me} onMe={setMe} />}
        {tab === "sources" && <SourcesView me={me} onChange={load} />}
        {tab === "channels" && <ChannelsView me={me} />}
        {tab === "calendar" && <CalendarView />}
        {tab === "brand" && <BrandView me={me} onMe={setMe} />}
        {tab === "plans" && <PlansView me={me} />}
        {tab === "billing" && <BillingView me={me} />}

        <footer className="legal">
          <a href="/service-terms">Service terms</a>
          <a href="/privacy">Privacy Policy</a>
          <a href="/pricing">Pricing</a>
        </footer>
      </main>
    </div>
  );
}

/** A failed action's message; a plan limit offers the way out. */
function Problem({ error }: { error: PortalError | Error | null }) {
  if (!error) return null;
  const limit = error instanceof PortalError && error.status === 402;
  return (
    <p className="error" role="alert">
      {error.message}{" "}
      {limit && (
        <a href="#plans" className="pt-upgrade">
          See plans
        </a>
      )}
    </p>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

// ---- Sign-in ----------------------------------------------------------------------------------

function SignIn({ note }: { note: string | null }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ demoLink?: string } | null>(null);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => setSent(await portal.emailLink(email)));
  };
  return (
    <main className="page pt-signin">
      <a className="brand" href="/service">
        <Logo />
        clipfarm
      </a>
      <section aria-labelledby="signin-title">
        <h1 id="signin-title">Sign in or sign up</h1>
        <p className="hint">Your streams, cut into Shorts, Reels and TikToks. New here? The same button makes your account.</p>
        {note && (
          <p className="error" role="alert">
            {note}
          </p>
        )}
        {sent ? (
          <div className="card">
            <h2>Check your email</h2>
            <p>
              We sent a sign-in link to <b>{email}</b>. It works once, for 30 minutes.
            </p>
            {sent.demoLink && (
              <a className="button primary" href={sent.demoLink}>
                Demo mode: open the sign-in link
              </a>
            )}
            <button type="button" className="link" onClick={() => setSent(null)}>
              Use another address
            </button>
          </div>
        ) : (
          <form className="card pt-form" onSubmit={submit}>
            <label>
              Email
              <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
            <Problem error={error} />
            <p className="pt-or">or</p>
            <a className="button" href="/portal/auth/google">
              Sign in with Google
            </a>
          </form>
        )}
        <p className="hint">
          By signing up you agree to the <a href="/service-terms">service terms</a>.
        </p>
      </section>
    </main>
  );
}

// ---- Dashboard --------------------------------------------------------------------------------

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="pt-meter">
      <div className="pt-meter-head">
        <span>{label}</span>
        <b>{limit === null ? `${compact(used)} (no limit)` : `${compact(used)} of ${compact(limit)}`}</b>
      </div>
      {limit !== null && (
        <div className={`meter${pct >= 100 ? " is-full" : ""}`} role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function Home({ me }: { me: PortalMe }) {
  const [dash, setDash] = useState<PortalDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    portal.dashboard().then(setDash, (err: Error) => setError(err.message));
  }, []);
  return (
    <section aria-labelledby="home-title">
      <div className="section-head">
        <h2 id="home-title">Hi {me.client.name}</h2>
      </div>
      <div className="card">
        <h3 className="pt-sub">{me.plan ? `${me.plan.name}: this month` : "No plan yet"}</h3>
        <p className="hint">
          {shortDate(me.usage.periodStart)} to {shortDate(me.usage.periodEnd)}
        </p>
        <Meter label="Minutes of video" used={me.usage.minutes} limit={me.plan?.minutes ?? 0} />
        <Meter label="Clips made" used={me.usage.clips} limit={me.plan?.clips ?? 0} />
      </div>
      {error && <p className="error">{error}</p>}
      {!dash && !error && <Skeleton shape="tiles" />}
      {dash && (
        <>
          <dl className="tiles">
            <div className="tile">
              <dt>
                <a href="#clips">Waiting for you</a>
              </dt>
              <dd>{dash.clipsWaiting}</dd>
            </div>
            <div className="tile">
              <dt>Approved</dt>
              <dd>{dash.clipsApproved}</dd>
            </div>
            <div className="tile">
              <dt>Posts</dt>
              <dd>{dash.posts}</dd>
            </div>
            <div className="tile">
              <dt>Views</dt>
              <dd>{compact(dash.views)}</dd>
            </div>
          </dl>
          <div className="card">
            <h3 className="pt-sub">Views by platform</h3>
            {dash.byPlatform.length === 0 ? (
              <p className="hint">Nothing posted yet. Views show here once clips go out.</p>
            ) : (
              <ul className="pt-rows">
                {dash.byPlatform.map((p) => (
                  <li key={p.platform}>
                    <span>{PLATFORM_LABELS[p.platform]}</span>
                    <span>
                      {p.posts} posts · <b>{compact(p.views)}</b> views
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {dash.topClips.length > 0 && (
            <div className="card">
              <h3 className="pt-sub">Your best clips</h3>
              <ul className="pt-rows">
                {dash.topClips.map((c) => (
                  <li key={c.id}>
                    <span>{c.title}</span>
                    <b>{compact(c.views)}</b>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---- Clips ------------------------------------------------------------------------------------

function ClipsView({ me, onMe }: { me: PortalMe; onMe: (m: PortalMe) => void }) {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [show, setShow] = useState<"pending" | "approved" | "rejected">("pending");
  const { busy, error, run } = useAction();
  const load = useCallback(() => portal.clips().then(setClips), []);
  useEffect(() => {
    void load().catch(() => setClips([]));
  }, [load]);
  const list = (clips ?? []).filter((c) => (show === "pending" ? c.status === "pending" : c.status === show));
  return (
    <section aria-labelledby="clips-title">
      <div className="section-head">
        <h2 id="clips-title">Clips</h2>
      </div>
      <label className="pt-toggle">
        <input
          type="checkbox"
          checked={me.client.autoApprove}
          disabled={busy || me.readOnly}
          onChange={(e) => {
            const on = e.target.checked;
            void run(async () => {
              onMe(await portal.settings(on));
              await load();
            });
          }}
        />
        <span>
          <b>Auto-approve</b>: new clips are approved as soon as they are cut.
        </span>
      </label>
      <div className="segmented pt-seg" role="tablist" aria-label="Which clips">
        {(["pending", "approved", "rejected"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={show === s} className={show === s ? "is-on" : undefined} onClick={() => setShow(s)}>
            {s === "pending" ? "To review" : s === "approved" ? "Approved" : "Rejected"}
          </button>
        ))}
      </div>
      <Problem error={error} />
      {clips === null && <Skeleton shape="card" count={2} />}
      {clips !== null && list.length === 0 && (
        <EmptyState icon="inbox" title={show === "pending" ? "Nothing to review" : "No clips here yet"} action={show === "pending" ? { label: "Add a video", href: "#sources" } : undefined}>
          {show === "pending" ? "New clips land here as your videos are cut." : "Clips you review show here."}
        </EmptyState>
      )}
      <ul className="pt-clips">
        {list.map((c) => (
          <li key={c.id} className="card pt-clip">
            <video src={`/api/portal/clips/${c.id}/video`} controls playsInline preload="metadata" />
            <div className="pt-clip-body">
              <h3>{c.title}</h3>
              <p className="hint">
                {duration(c.durationSec)}
                {c.score !== null ? ` · score ${Math.round(c.score)}` : ""}
              </p>
              {c.status === "pending" && !me.readOnly && (
                <div className="pt-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await portal.approve(c.id);
                        await load();
                      })
                    }
                  >
                    <Icon name="approve" /> Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await portal.reject(c.id, null);
                        await load();
                      })
                    }
                  >
                    <Icon name="reject" /> Reject
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Videos (sources) -------------------------------------------------------------------------

const VIDEO_STATUS: Record<string, string> = {
  queued: "Waiting",
  downloading: "Downloading",
  transcribing: "Listening",
  ready: "Cut into clips",
  failed: "Did not work",
};

function SourcesView({ me, onChange }: { me: PortalMe; onChange: () => Promise<void> }) {
  const [data, setData] = useState<{ sources: PortalSource[]; videos: PortalVideo[] } | null>(null);
  const [form, setForm] = useState({ name: me.workspace.name, link: "", ownerName: me.client.name, attested: false });
  const { busy, error, run } = useAction();
  useEffect(() => {
    portal.sources().then(setData, () => setData({ sources: [], videos: [] }));
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setData(await portal.addSource(form));
      setForm((f) => ({ ...f, link: "", attested: false }));
      await onChange();
    });
  };
  return (
    <section aria-labelledby="sources-title">
      <div className="section-head">
        <h2 id="sources-title">Videos and channels</h2>
      </div>
      {!me.readOnly && (
        <form className="card pt-form" onSubmit={submit}>
          <h3 className="pt-sub">Add a video or channel</h3>
          <label>
            Link
            <input type="url" required value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://www.youtube.com/@you or a video link" />
          </label>
          <label>
            Channel or show name
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Who owns the videos
            <input required value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
          </label>
          <label className="pt-check">
            <input type="checkbox" checked={form.attested} onChange={(e) => setForm({ ...form, attested: e.target.checked })} />
            <span>I own these videos, or have the owner's OK to clip them.</span>
          </label>
          <button type="submit" className="primary" disabled={busy || !form.attested}>
            {busy ? "Adding…" : "Add"}
          </button>
          <p className="hint">A channel is watched: its new videos are cut by themselves. Each video counts towards your monthly minutes.</p>
          <Problem error={error} />
        </form>
      )}
      {data === null && <Skeleton shape="rows" count={3} />}
      {data && data.sources.length === 0 && (
        <EmptyState icon="sources" title="No videos yet">
          Paste a link above to make your first clips.
        </EmptyState>
      )}
      {data?.sources.map((s) => (
        <div key={s.id} className="card">
          <div className="card-head">
            <h3>{s.name}</h3>
            {!me.readOnly && (
              <button
                type="button"
                className="close"
                aria-label={`Remove ${s.name}`}
                onClick={() => {
                  if (window.confirm(`Remove ${s.name} with its videos and clips?`)) void run(async () => setData(await portal.removeSource(s.id)));
                }}
              >
                ×
              </button>
            )}
          </div>
          <ul className="pt-rows">
            {data.videos
              .filter((v) => v.sourceId === s.id)
              .map((v) => (
                <li key={v.id}>
                  <span className="pt-ellipsis">{v.title ?? v.url}</span>
                  <span className={v.status === "failed" ? "pt-bad" : undefined}>
                    {VIDEO_STATUS[v.status] ?? v.status}
                    {v.durationSec ? ` · ${duration(v.durationSec)}` : ""}
                  </span>
                </li>
              ))}
            {data.videos.every((v) => v.sourceId !== s.id) && <li className="hint">Watching for new videos.</li>}
          </ul>
        </div>
      ))}
    </section>
  );
}

// ---- Channels ---------------------------------------------------------------------------------

function ChannelsView({ me }: { me: PortalMe }) {
  const [data, setData] = useState<{ accounts: PortalAccount[]; connectable: Platform[] } | null>(null);
  const { busy, error, run } = useAction();
  const params = new URLSearchParams(window.location.search);
  useEffect(() => {
    portal.accounts().then(setData, () => setData({ accounts: [], connectable: [] }));
  }, []);
  const platforms = me.plan?.platforms ?? [];
  return (
    <section aria-labelledby="channels-title">
      <div className="section-head">
        <h2 id="channels-title">Your channels</h2>
      </div>
      {params.get("connect") === "ok" && <p className="pt-banner pt-ok">Channel connected.</p>}
      {params.get("connect") === "failed" && <p className="error">The channel was not connected. Try again.</p>}
      {me.plan?.kind === "managed" && <p className="hint">On {me.plan.name} we post on our channels for you. You can still connect your own.</p>}
      {data === null && <Skeleton shape="rows" count={2} />}
      {data && (
        <ul className="pt-rows card">
          {data.accounts.length === 0 && <li className="hint">No channel connected yet.</li>}
          {data.accounts.map((a) => (
            <li key={a.id}>
              <span>
                <b>{PLATFORM_LABELS[a.platform]}</b> {a.name}
              </span>
              <span>{a.disabled ? "Off" : "Connected"}</span>
            </li>
          ))}
        </ul>
      )}
      {!me.readOnly && (
        <div className="card">
          <h3 className="pt-sub">Connect a channel</h3>
          {platforms.length === 0 && <p className="hint">Pick a plan first: it says where your clips can post.</p>}
          <div className="pt-actions pt-wrap">
            {platforms.map((p) => (
              <button key={p} type="button" disabled={busy} onClick={() => void run(async () => (window.location.href = (await portal.connect(p)).url))}>
                {PLATFORM_LABELS[p]}
              </button>
            ))}
          </div>
          <Problem error={error} />
        </div>
      )}
    </section>
  );
}

// ---- Calendar ---------------------------------------------------------------------------------

function CalendarView() {
  const [items, setItems] = useState<PortalCalendarItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const from = new Date(Date.now() - 14 * 86_400_000);
    const to = new Date(Date.now() + 30 * 86_400_000);
    portal.calendar(from, to).then(
      (c) => setItems(c.items),
      (err: Error) => setError(err.message),
    );
  }, []);
  const days = new Map<string, PortalCalendarItem[]>();
  for (const i of [...(items ?? [])].sort((a, b) => a.at.localeCompare(b.at))) {
    const day = new Date(i.at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    days.set(day, [...(days.get(day) ?? []), i]);
  }
  return (
    <section aria-labelledby="cal-title">
      <div className="section-head">
        <h2 id="cal-title">Calendar</h2>
      </div>
      <p className="hint">Your posts from two weeks ago to a month ahead.</p>
      {error && <p className="error">{error}</p>}
      {items === null && !error && <Skeleton shape="rows" count={3} />}
      {items?.length === 0 && (
        <EmptyState icon="calendar" title="Nothing planned">
          Approved clips show here when they are given a time.
        </EmptyState>
      )}
      {[...days].map(([day, list]) => (
        <div key={day} className="card">
          <h3 className="pt-sub">{day}</h3>
          <ul className="pt-rows">
            {list.map((i) => (
              <li key={i.id}>
                <span className="pt-ellipsis">
                  {new Date(i.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · {PLATFORM_LABELS[i.platform]} · {i.title}
                </span>
                <span>
                  {i.url ? (
                    <a href={i.url} target="_blank" rel="noreferrer">
                      {SLOT_STATUS_LABELS[i.status as SlotStatus] ?? i.status}
                    </a>
                  ) : (
                    (SLOT_STATUS_LABELS[i.status as SlotStatus] ?? i.status)
                  )}
                  {i.views !== null ? ` · ${compact(i.views)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

// ---- Brand ------------------------------------------------------------------------------------

function BrandView({ me, onMe }: { me: PortalMe; onMe: (m: PortalMe) => void }) {
  const [brand, setBrand] = useState(me.workspace.brand);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    void run(async () => {
      onMe(await portal.brand(brand));
      setSaved(true);
    });
  };
  return (
    <section aria-labelledby="brand-title">
      <div className="section-head">
        <h2 id="brand-title">Brand kit</h2>
      </div>
      <form className="card pt-form" onSubmit={submit}>
        <label>
          Caption colour
          <span className="pt-color">
            <input type="color" value={brand.color} disabled={me.readOnly} onChange={(e) => setBrand({ ...brand, color: e.target.value })} aria-label="Pick the colour" />
            <input value={brand.color} disabled={me.readOnly} onChange={(e) => setBrand({ ...brand, color: e.target.value })} />
          </span>
        </label>
        <label>
          Your @handle
          <input value={brand.handle} disabled={me.readOnly} onChange={(e) => setBrand({ ...brand, handle: e.target.value })} placeholder="@you" />
        </label>
        <label>
          Closing line for descriptions
          <input value={brand.callToAction} disabled={me.readOnly} onChange={(e) => setBrand({ ...brand, callToAction: e.target.value })} placeholder="Full stream on the channel" />
        </label>
        {!me.readOnly && (
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        )}
        {saved && <p className="pt-ok-text">Saved. New clips use it.</p>}
        <Problem error={error} />
      </form>
    </section>
  );
}

// ---- Plans and billing ------------------------------------------------------------------------

function PlanCard({ plan, current, children }: { plan: Plan; current: boolean; children: ReactNode }) {
  return (
    <article className={`card pt-plan${current ? " is-current" : ""}`}>
      <p className="hint">{PLAN_KIND_LABELS[plan.kind]}</p>
      <h3>{plan.name}</h3>
      <p className="pt-price">{planPrice(plan)}</p>
      <p>{plan.blurb}</p>
      <ul>
        <li>{plan.minutes === null ? "No limit on minutes" : `${plan.minutes} minutes of video a month`}</li>
        <li>{plan.clips === null ? "No limit on clips" : `Up to ${plan.clips} clips a month`}</li>
        <li>Posts to {plan.platforms.map((p) => PLATFORM_LABELS[p]).join(", ")}</li>
        {plan.kind === "managed" && <li>We post for you</li>}
      </ul>
      {children}
    </article>
  );
}

function PlansView({ me }: { me: PortalMe }) {
  const { busy, error, run } = useAction();
  const wanted = recall(PLAN_KEY);
  const inForce = me.plan && ["active", "trialing", "past_due"].includes(me.client.status);
  return (
    <section aria-labelledby="plans-title">
      <div className="section-head">
        <h2 id="plans-title">Plans</h2>
      </div>
      <p className="hint">Prices before VAT; VAT is added at checkout where it applies. Change or cancel at any time.</p>
      <Problem error={error} />
      <div className="pt-plans">
        {me.plans.map((p) => {
          const current = !!inForce && me.plan?.id === p.id;
          return (
            <PlanCard key={p.id} plan={p} current={current}>
              {current ? (
                <p className="pt-ok-text">Your plan</p>
              ) : (
                !me.readOnly && (
                  <button
                    type="button"
                    className={wanted === p.id || !inForce ? "primary" : undefined}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const { url } = await portal.checkout(p.id);
                        remember(PLAN_KEY, null);
                        window.location.href = url;
                      })
                    }
                  >
                    {inForce ? `Switch to ${p.name}` : `Choose ${p.name}`}
                  </button>
                )
              )}
            </PlanCard>
          );
        })}
      </div>
    </section>
  );
}

const STATUS_LABEL: Record<string, string> = {
  none: "No plan",
  active: "Active",
  trialing: "Trial",
  past_due: "Payment failed",
  unpaid: "Unpaid",
  canceled: "Cancelled",
  incomplete: "Waiting for payment",
  incomplete_expired: "Payment not finished",
  paused: "Paused",
};

function BillingView({ me }: { me: PortalMe }) {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    portal.invoices().then(setInvoices, () => setInvoices([]));
  }, []);
  return (
    <section aria-labelledby="billing-title">
      <div className="section-head">
        <h2 id="billing-title">Billing</h2>
      </div>
      <div className="card">
        <p>
          Plan: <b>{me.plan?.name ?? "none"}</b> · {STATUS_LABEL[me.client.status] ?? me.client.status}
        </p>
        <p className="hint">Change your card, address or VAT number, switch or cancel your plan on Stripe's secure page. We never see your card.</p>
        {!me.readOnly && (
          <button type="button" className="primary" disabled={busy || me.client.status === "none"} onClick={() => void run(async () => (window.location.href = (await portal.billing()).url))}>
            Manage billing
          </button>
        )}
        <Problem error={error} />
      </div>
      <div className="card">
        <h3 className="pt-sub">Invoices</h3>
        {invoices === null && <Skeleton shape="rows" count={2} />}
        {invoices?.length === 0 && <p className="hint">No invoices yet.</p>}
        <ul className="pt-rows">
          {invoices?.map((i) => (
            <li key={i.id}>
              <span>
                {shortDate(i.createdAt)} {i.number ? `· ${i.number}` : ""}
              </span>
              <span>
                {money(i.amountDue, i.currency)} · {i.status === "paid" ? "Paid" : i.status === "open" ? "Due" : i.status}
                {i.hostedUrl && (
                  <>
                    {" · "}
                    <a href={i.hostedUrl} target="_blank" rel="noreferrer">
                      View
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
