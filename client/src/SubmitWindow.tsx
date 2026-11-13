import { type FormEvent, useCallback, useEffect, useState } from "react";
import { SNOOZE_LABELS, SNOOZES, SUBMIT_WINDOW_MIN, type Snooze, type SubmitHours, type SubmitWindowInfo } from "../../shared/submitWindow";
import { api } from "./api";
import { whenShort } from "./submitFormat";

function timeZones(hours: SubmitHours): string[] {
  const all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return all.includes(hours.timeZone) ? all : [hours.timeZone, ...all];
}

/** Settings, Posting: when the manager can submit campaign clips. */
export function SubmitHoursCard() {
  const [info, setInfo] = useState<SubmitWindowInfo | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    api.submitWindow().then(
      (i) => on && setInfo(i),
      (err: Error) => on && setMsg(err.message),
    );
    return () => {
      on = false;
    };
  }, []);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "");
    try {
      setInfo(
        await api.saveSubmitHours({
          enabled: f.get("enabled") === "on",
          timeZone: text("timeZone"),
          weekdays: { from: text("weekdaysFrom"), to: text("weekdaysTo") },
          weekends: { from: text("weekendsFrom"), to: text("weekendsTo") },
        }),
      );
      setMsg("Saved. Campaign posts that wait were moved to fit.");
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  const h = info?.hours;
  return (
    <div className="card submit-hours" id="settings-posting" data-testid="settings-posting">
      <div className="card-head">
        <h3>Posting: submit hours</h3>
        {h && <span className={h.enabled ? "state state-active" : "state state-idle"}>{h.enabled ? "On" : "Off"}</span>}
      </div>
      <p className="hint key-purpose">
        Campaigns pay only when a clip is submitted within {SUBMIT_WINDOW_MIN} minutes of posting, and you do that by hand. So campaign clips go out only in
        the hours you can submit. Your own clips and experiments post at any hour.
      </p>
      {h && (
        <form className="form" onSubmit={save}>
          <label className="switch">
            <input type="checkbox" role="switch" name="enabled" defaultChecked={h.enabled} />
            Post campaign clips only in these hours
          </label>
          <fieldset>
            <legend>Monday to Friday</legend>
            <div className="row">
              <label>
                From
                <input type="time" name="weekdaysFrom" required defaultValue={h.weekdays.from} />
              </label>
              <label>
                To
                <input type="time" name="weekdaysTo" required defaultValue={h.weekdays.to} />
              </label>
            </div>
          </fieldset>
          <fieldset>
            <legend>Saturday and Sunday</legend>
            <div className="row">
              <label>
                From
                <input type="time" name="weekendsFrom" required defaultValue={h.weekends.from} />
              </label>
              <label>
                To
                <input type="time" name="weekendsTo" required defaultValue={h.weekends.to} />
              </label>
            </div>
          </fieldset>
          <label>
            Time zone
            <select name="timeZone" defaultValue={h.timeZone}>
              {timeZones(h).map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Save submit hours</button>
        </form>
      )}
      {msg && (
        <p className="hint" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}

/** Dashboard: "I'm busy" moves the campaign posts that are due while the manager cannot submit. */
export function BusyCard() {
  // With the moment it was read, to say "today" or "tomorrow".
  const [read, setRead] = useState<{ info: SubmitWindowInfo; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setInfo = useCallback((info: SubmitWindowInfo) => setRead({ info, at: Date.now() }), []);

  const load = useCallback(() => api.submitWindow().then(setInfo, (err: Error) => setError(err.message)), [setInfo]);
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    // A snooze taken on a notification shows here too.
    const t = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  if (!read) return error ? <p className="error" role="alert">{error}</p> : null;
  const { info, at: now } = read;

  const snooze = (choice: Snooze | "off") => {
    setError(null);
    void api.snooze(choice).then(setInfo, (err: Error) => setError(err.message));
  };
  const { hours } = info;
  const waiting =
    info.waiting === 0
      ? "No campaign post is waiting."
      : `${info.waiting} campaign post${info.waiting === 1 ? " waits" : "s wait"}, the next goes out ${whenShort(info.nextAt!, now)}.`;
  return (
    <div className="card busy" data-testid="busy">
      <div className="card-head">
        <h3>Campaign submits</h3>
        {info.snoozeUntil ? (
          <span className="state state-needs-review">Busy until {new Date(info.snoozeUntil).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</span>
        ) : (
          <span className="state state-active">{hours.enabled ? "Ready" : "Any hour"}</span>
        )}
      </div>
      {info.open > 0 && (
        <p className="busy-open">
          <a href="#posted">
            {info.open} clip{info.open === 1 ? " is" : "s are"} live: submit now
          </a>
        </p>
      )}
      <p className="hint">
        {info.snoozeUntil ? "Campaign clips are held until you are back. " : "A campaign clip pays only if you submit it within 30 minutes of posting. "}
        {waiting}
      </p>
      <div className="actions" role="group" aria-label="I'm busy">
        <span className="busy-label">I'm busy for</span>
        {SNOOZES.map((s) => (
          <button key={s} type="button" onClick={() => snooze(s)}>
            {SNOOZE_LABELS[s]}
          </button>
        ))}
        {info.snoozeUntil && (
          <button type="button" className="primary" onClick={() => snooze("off")}>
            I'm back
          </button>
        )}
      </div>
      <p className="hint">
        {hours.enabled
          ? `Submit hours: ${hours.weekdays.from} to ${hours.weekdays.to} on weekdays, ${hours.weekends.from} to ${hours.weekends.to} on weekends. `
          : "Submit hours are off: campaign clips post at any hour. "}
        <a href="#settings/posting">Change</a>
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
