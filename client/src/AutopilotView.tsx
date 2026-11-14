import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { AutopilotInfo, AutopilotRule, AutopilotStep } from "../../shared/publishing";
import type { ChannelAccount, Source } from "../../shared/types";
import { PERMISSION_KIND_LABELS, PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";

type RuleInput = Omit<AutopilotRule, "id">;

const NEW_RULE: RuleInput = {
  name: "",
  enabled: false,
  sourceId: null,
  permissionId: null,
  minScore: 75,
  needsQuality: true,
  accountIds: [],
  auto: false,
  burnerOnly: false,
  dailyCap: 3,
  dryRun: true,
};

const ACTION_LABELS: Record<AutopilotStep["action"], string> = { post: "Posts", "wait-approval": "Waits for your tap", skip: "Skips" };

const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** "When a clip from TJR under its campaign scores 80 or more and passes the quality check → …" */
function summary(rule: AutopilotRule, sources: Source[], accounts: ChannelAccount[]): string {
  const source = sources.find((s) => s.id === rule.sourceId);
  const campaign = source?.permissions.find((p) => p.id === rule.permissionId) ?? sources.flatMap((s) => s.permissions).find((p) => p.id === rule.permissionId);
  const from = source ? `from ${source.creatorName}` : "from any source";
  const under = campaign ? ` under its ${PERMISSION_KIND_LABELS[campaign.kind].toLowerCase()}` : "";
  const names = rule.accountIds.map((id) => accounts.find((a) => a.id === id)?.name ?? "a disconnected account").join(", ");
  const submit = campaign?.kind === "whop-campaign" ? " → remind me to submit it to the campaign within 30 minutes, with the link" : "";
  return `When a clip ${from}${under} scores ${rule.minScore} or more${rule.needsQuality ? " and passes the quality check" : ""} → post to ${names} at the next best slot${submit}.`;
}

export function AutopilotView({ sources }: { sources: Source[] }) {
  const [info, setInfo] = useState<AutopilotInfo | null>(null);
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number | null; rule: RuleInput } | null>(null);
  const [dry, setDry] = useState<{ ruleId: number; steps: AutopilotStep[] } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api.autopilot());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    api.posting().then(
      (p) => setAccounts(p.accounts),
      (err: Error) => setError(err.message),
    );
    return () => clearTimeout(first);
  }, [load]);

  const save = async (id: number, change: Partial<RuleInput>) => {
    const rule = info?.rules.find((r) => r.id === id);
    if (!rule) return;
    setBusy(id);
    try {
      const { id: _id, ...rest } = rule;
      await api.saveRule(id, { ...rest, ...change });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const dryRun = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      setDry({ ruleId: id, steps: await api.dryRunRule(id) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p className="hint">
        Rules post good clips by themselves at each platform's next best time, within every limit. Every post still needs a permission record. Main accounts wait for
        your approve tap unless a rule says otherwise; burner rules post only to burners.
      </p>
      <button type="button" className="primary" onClick={() => setEditing({ id: null, rule: NEW_RULE })}>
        New rule
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!info && !error && <p className="hint">Loading rules…</p>}
      {info?.rules.length === 0 && <p className="empty">No rules yet. A new rule starts switched off and in dry run, so you can see what it would do first.</p>}
      <div className="ap-rules">
        {info?.rules.map((rule) => (
          <article key={rule.id} className="card ap-rule">
            <div className="card-head">
              <h3>{rule.name}</h3>
              <span className={`state ${rule.enabled ? (rule.dryRun ? "state-needs-review" : "state-active") : "state-none"}`}>
                {rule.enabled ? (rule.dryRun ? "Dry run" : "On") : "Off"}
              </span>
            </div>
            <p>{summary(rule, sources, accounts)}</p>
            <p className="hint">
              At most {rule.dailyCap} post{rule.dailyCap === 1 ? "" : "s"} a day.{" "}
              {rule.burnerOnly ? "Burner accounts only." : rule.auto ? "Posts to main accounts without your tap." : "Main accounts wait for your approve tap."}
            </p>
            <div className="ap-switches">
              <label className="switch">
                <input type="checkbox" checked={rule.enabled} disabled={busy === rule.id} onChange={(e) => void save(rule.id, { enabled: e.target.checked })} />
                On
              </label>
              <label className="switch">
                <input type="checkbox" checked={rule.dryRun} disabled={busy === rule.id} onChange={(e) => void save(rule.id, { dryRun: e.target.checked })} />
                Dry run only
              </label>
            </div>
            <div className="chips">
              <button type="button" disabled={busy === rule.id} onClick={() => void dryRun(rule.id)}>
                {busy === rule.id ? "Checking…" : "What would it do now?"}
              </button>
              <button type="button" onClick={() => setEditing({ id: rule.id, rule: { ...rule } })}>
                Edit
              </button>
              <button
                type="button"
                className="link"
                onClick={async () => {
                  if (!window.confirm(`Delete the rule "${rule.name}"? Posts it made stay.`)) return;
                  try {
                    await api.deleteRule(rule.id);
                    await load();
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              >
                Delete
              </button>
            </div>
            {dry?.ruleId === rule.id && (
              <div className="ap-dry" role="status">
                <h4>Dry run: nothing was posted</h4>
                {dry.steps.length === 0 ? <p className="hint">No clip fits this rule right now.</p> : <Steps steps={dry.steps} />}
                <button type="button" className="link" onClick={() => setDry(null)}>
                  Hide
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {info && info.recent.length > 0 && (
        <>
          <h3 className="cal-sub">What the rules did</h3>
          <Steps steps={info.recent} withRule />
        </>
      )}
      {editing && (
        <RuleSheet
          id={editing.id}
          initial={editing.rule}
          sources={sources}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </>
  );
}

function Steps({ steps, withRule = false }: { steps: AutopilotStep[]; withRule?: boolean }) {
  return (
    <ul className="ap-steps">
      {steps.map((s, i) => (
        <li key={`${s.ruleId}-${s.clipId}-${s.accountId}-${i}`} className={`ap-step ap-${s.action}`}>
          <span className="ap-step-head">
            <strong>{ACTION_LABELS[s.action]}</strong> {s.clipTitle}
            {s.accountName && ` → ${s.accountName}`}
            {s.at && ` · ${when(s.at)}`}
            {s.dryRun && withRule && <span className="state state-needs-review">Dry run</span>}
          </span>
          <span className="hint">
            {withRule && `${s.ruleName}: `}
            {s.reason}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RuleSheet({
  id,
  initial,
  sources,
  accounts,
  onClose,
  onSaved,
}: {
  id: number | null;
  initial: RuleInput;
  sources: Source[];
  accounts: ChannelAccount[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [rule, setRule] = useState<RuleInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const source = sources.find((s) => s.id === rule.sourceId);
  const shown = accounts.filter((a) => !rule.burnerOnly || a.role === "burner");
  const set = (change: Partial<RuleInput>) => setRule((r) => ({ ...r, ...change }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.saveRule(id, rule);
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet id="rule-sheet-title" title={id === null ? "New rule" : "Edit rule"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input value={rule.name} required maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="TJR big moments" />
        </label>
        <div className="row">
          <label>
            Clips from
            <select value={rule.sourceId ?? ""} onChange={(e) => set({ sourceId: e.target.value ? Number(e.target.value) : null, permissionId: null })}>
              <option value="">Any source</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.creatorName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Under
            <select value={rule.permissionId ?? ""} disabled={!source} onChange={(e) => set({ permissionId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Any permission</option>
              {source?.permissions.map((p) => (
                <option key={p.id} value={p.id}>
                  {PERMISSION_KIND_LABELS[p.kind]}
                  {p.campaignUrl ? ` · ${new URL(p.campaignUrl).hostname.replace(/^www\./, "")}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            Score at least
            <input type="number" min={0} max={100} required value={rule.minScore} onChange={(e) => set({ minScore: Number(e.target.value) })} />
          </label>
          <label>
            Posts a day at most
            <input type="number" min={1} max={50} required value={rule.dailyCap} onChange={(e) => set({ dailyCap: Number(e.target.value) })} />
          </label>
        </div>
        <label className="switch">
          <input type="checkbox" checked={rule.needsQuality} onChange={(e) => set({ needsQuality: e.target.checked })} />
          Only clips that passed the quality check
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={rule.burnerOnly}
            onChange={(e) => set({ burnerOnly: e.target.checked, accountIds: e.target.checked ? rule.accountIds.filter((x) => accounts.find((a) => a.id === x)?.role === "burner") : rule.accountIds })}
          />
          Burner accounts only (tests and experiments)
        </label>
        <fieldset>
          <legend>Post to</legend>
          {shown.length === 0 && <p className="hint">{rule.burnerOnly ? "No burner account yet. Mark one as Burner in Dashboard, Accounts." : "No accounts are connected yet."}</p>}
          <div className="chips">
            {shown.map((a) => (
              <label key={a.id} className="chip">
                <input
                  type="checkbox"
                  checked={rule.accountIds.includes(a.id)}
                  onChange={() => set({ accountIds: rule.accountIds.includes(a.id) ? rule.accountIds.filter((x) => x !== a.id) : [...rule.accountIds, a.id] })}
                />
                {a.name} · {PLATFORM_LABELS[a.platform]}
                {a.role === "burner" && <span className="state role-burner">Burner</span>}
              </label>
            ))}
          </div>
        </fieldset>
        {!rule.burnerOnly && (
          <label className="switch">
            <input type="checkbox" checked={rule.auto} onChange={(e) => set({ auto: e.target.checked })} />
            Post to main accounts without my approve tap
          </label>
        )}
        <label className="switch">
          <input type="checkbox" checked={rule.dryRun} onChange={(e) => set({ dryRun: e.target.checked })} />
          Dry run only: show what it would do, post nothing
        </label>
        <label className="switch">
          <input type="checkbox" checked={rule.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          On
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save rule"}
        </button>
      </form>
    </Sheet>
  );
}
