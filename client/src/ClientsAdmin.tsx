import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Platform } from "../../shared/types";
import { PLATFORM_LABELS, PLATFORMS } from "../../shared/types";
import type { AdminClients, Plan } from "../../shared/service";
import { money, PLAN_KIND_LABELS, PLAN_KINDS, planPrice } from "../../shared/service";
import { api } from "./api";
import { compact, shortDate } from "./format";
import { Sheet } from "./Sheet";

const STATUS: Record<string, string> = {
  none: "No plan",
  active: "Active",
  trialing: "Trial",
  past_due: "Payment failed",
  unpaid: "Unpaid",
  canceled: "Cancelled",
  incomplete: "Checkout not finished",
  incomplete_expired: "Checkout not finished",
  paused: "Paused",
};

/** The clipping service's clients (each with a workspace): plan, usage, MRR, overdue, and a read-only look as them. */
export function ClientsAdmin() {
  const [data, setData] = useState<AdminClients | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | "new" | null>(null);
  const load = useCallback(() => api.clients().then(setData, (err: Error) => setError(err.message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h3 className="creator-sub">Clients</h3>
      <p className="hint">
        Creators who signed up at <a href="/service">/service</a>. Each gets a workspace of their own and sees only it.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <dl className="tiles">
            <div className="tile">
              <dt>Clients</dt>
              <dd>{data.clients.length}</dd>
            </div>
            <div className="tile">
              <dt>MRR</dt>
              <dd>{data.mrr.length === 0 ? "0" : data.mrr.map((m) => money(m.cents, m.currency)).join(" + ")}</dd>
            </div>
            <div className="tile">
              <dt>Overdue</dt>
              <dd>{data.overdue}</dd>
            </div>
          </dl>
          {data.clients.length === 0 ? (
            <p className="hint">No clients yet.</p>
          ) : (
            <ul className="ws-list">
              {data.clients.map((c) => (
                <li key={c.id}>
                  <strong>
                    {c.name} <span className="hint">{c.email}</span>
                  </strong>
                  <span>
                    {c.planName ?? "No plan"} · {STATUS[c.status] ?? c.status}
                    {c.overdue && <b className="overdue"> · Overdue</b>}
                    {c.mrrCents > 0 && ` · ${money(c.mrrCents, c.currency)} a month`}
                  </span>
                  <span className="hint">
                    This period: {c.usage.minutes} min · {c.usage.clips} clips · {c.usage.posts} posts · {compact(c.usage.views)} views · since {shortDate(c.createdAt)}
                  </span>
                  <span>
                    <button
                      type="button"
                      onClick={() =>
                        void api.supportView(c.id).then(
                          ({ url }) => window.open(url, "_blank", "noopener"),
                          (err: Error) => setError(err.message),
                        )
                      }
                    >
                      View as client (read-only)
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="section-head">
            <h3 className="creator-sub">Plans</h3>
            <button type="button" onClick={() => setEditing("new")}>
              Add a plan
            </button>
          </div>
          <ul className="ws-list">
            {data.plans.map((p) => (
              <li key={p.id}>
                <strong>
                  {p.name} <span className="hint">{PLAN_KIND_LABELS[p.kind]}</span>
                  {!p.active && <span className="hint"> · not offered</span>}
                </strong>
                <span>{planPrice(p)}</span>
                <span className="hint">
                  {p.minutes ?? "No limit on"} min · {p.clips ?? "no limit on"} clips · {p.platforms.map((x) => PLATFORM_LABELS[x]).join(", ")}
                  {p.stripePriceId || p.stripeViewsPriceId ? " · in Stripe" : " · not in Stripe yet (IT runs the Stripe setup)"}
                </span>
                <span>
                  <button type="button" onClick={() => setEditing(p)}>
                    Edit
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {editing && (
        <PlanSheet
          plan={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(d) => {
            setData(d);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

const units = (cents: number | null) => (cents === null ? "" : String(cents / 100));
const toCents = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));
const orNull = (v: string) => (v.trim() === "" ? null : Number(v));

function PlanSheet({ plan, onClose, onSaved }: { plan: Plan | null; onClose: () => void; onSaved: (d: AdminClients) => void }) {
  const [platforms, setPlatforms] = useState<Platform[]>(plan?.platforms ?? ["youtube", "tiktok"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (n: string) => String(f.get(n) ?? "");
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.savePlan(
          {
            id: text("id"),
            name: text("name"),
            kind: text("kind"),
            blurb: text("blurb"),
            currency: text("currency"),
            monthlyCents: toCents(text("monthly")) ?? 0,
            per1kViewsCents: toCents(text("per1k")),
            minutes: orNull(text("minutes")),
            clips: orNull(text("clips")),
            brandTemplates: Number(text("brandTemplates") || 0),
            platforms,
            active: f.get("active") === "on",
          },
          plan?.id,
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet id="plan-sheet" title={plan ? `Edit ${plan.name}` : "Add a plan"} onClose={onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        {!plan && (
          <label>
            Short id (letters, digits, dashes)
            <input name="id" required pattern="[a-z0-9][a-z0-9-]{1,30}" placeholder="creator-plus" />
          </label>
        )}
        <label>
          Name
          <input name="name" required defaultValue={plan?.name} maxLength={40} />
        </label>
        <label>
          Kind
          <select name="kind" defaultValue={plan?.kind ?? "self-serve"}>
            {PLAN_KINDS.map((k) => (
              <option key={k} value={k}>
                {PLAN_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          One line for the pricing page
          <input name="blurb" defaultValue={plan?.blurb} maxLength={200} />
        </label>
        <label>
          Currency
          <input name="currency" defaultValue={plan?.currency ?? "eur"} pattern="[a-z]{3}" />
        </label>
        <label>
          Monthly price (0 for none)
          <input name="monthly" inputMode="decimal" defaultValue={units(plan?.monthlyCents ?? 0)} />
        </label>
        <label>
          Price per 1,000 views (empty for none)
          <input name="per1k" inputMode="decimal" defaultValue={units(plan?.per1kViewsCents ?? null)} />
        </label>
        <label>
          Minutes of video a month (empty: no limit)
          <input name="minutes" inputMode="numeric" defaultValue={plan?.minutes ?? ""} />
        </label>
        <label>
          Clips a month (empty: no limit)
          <input name="clips" inputMode="numeric" defaultValue={plan?.clips ?? ""} />
        </label>
        <label>
          Brand templates (0: no brand kit)
          <input name="brandTemplates" inputMode="numeric" defaultValue={plan?.brandTemplates ?? 1} />
        </label>
        <fieldset className="chips">
          <legend>Platforms</legend>
          {PLATFORMS.map((p) => (
            <label key={p} className="chip">
              <input type="checkbox" checked={platforms.includes(p)} onChange={(e) => setPlatforms(e.target.checked ? [...platforms, p] : platforms.filter((x) => x !== p))} />
              {PLATFORM_LABELS[p]}
            </label>
          ))}
        </fieldset>
        <label className="attest">
          <input type="checkbox" name="active" defaultChecked={plan?.active ?? true} />
          Offered on the pricing page
        </label>
        <p className="hint">A new price needs new Stripe prices: IT's Stripe setup makes them on its next run.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          Save
        </button>
      </form>
    </Sheet>
  );
}
