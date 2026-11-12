import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { LiveCreatorStatus, LiveInfo } from "../../shared/types";
import { WATCH_PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { type PushState, pushState, turnOffPush, turnOnPush } from "./push";

/** Days, hours, minutes and seconds until `target`; all zero once it has passed. */
export function countdownParts(target: string, now: number): { value: string; unit: string }[] {
  const left = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return [
    { value: String(Math.floor(left / 86_400)), unit: "days" },
    { value: two(Math.floor((left % 86_400) / 3600)), unit: "hours" },
    { value: two(Math.floor((left % 3600) / 60)), unit: "min" },
    { value: two(left % 60), unit: "sec" },
  ];
}

/** An ISO time as the value of a datetime-local field (the manager's own time zone). */
function toLocalField(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

const PUSH_NOTE: Record<PushState, string> = {
  on: "This device gets a notification when live mode starts on a creator and when the first LIVE clip lands.",
  off: "Get a notification when live mode starts on a creator and when the first LIVE clip lands.",
  blocked: "Notifications are blocked for clipfarm in this browser. Allow them in the browser's site settings, then come back.",
  unavailable: "Notifications need the installed app: add clipfarm to your home screen, open it from there, and turn them on here.",
};

/**
 * Launch day: the countdown to GTA VI, the Arm and Disarm switch of live mode, and one switch per
 * permitted creator. Before launch time GTA VI streams are never recorded.
 */
export function LaunchCard({ refreshKey }: { refreshKey: string }) {
  const [info, setInfo] = useState<LiveInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [push, setPush] = useState<PushState>("unavailable");

  const load = useCallback(() => api.live().then(setInfo, () => undefined), []);
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    // The card also changes by itself: launch time arrives, a stream starts or ends.
    const poll = setInterval(() => void load(), 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [load, refreshKey]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    void pushState().then(setPush, () => undefined);
    return () => clearInterval(tick);
  }, []);

  if (!info) return null;

  const change = (call: () => Promise<LiveInfo>) => {
    setBusy(true);
    setError(null);
    call()
      .then(setInfo, (err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  const saveTime = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("launchAt") ?? "");
    const at = new Date(value);
    if (!value || Number.isNaN(at.getTime())) {
      setError("Pick the launch date and time.");
      return;
    }
    setEditing(false);
    change(() => api.setLaunchAt(at.toISOString()));
  };
  const togglePush = () => {
    setError(null);
    const next = push === "on" ? turnOffPush() : turnOnPush(info.push.publicKey!);
    next.then(setPush, (err: Error) => setError(`Notifications could not be changed: ${err.message}`));
  };

  const launched = new Date(info.launchAt).getTime() <= now;
  const recording = info.creators.filter((c) => c.recording).length;
  const when = new Date(info.launchAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="launch" data-testid="launch-card">
      <div className="launch-well">
        <div className="launch-head">
          <h3>Launch day</h3>
          <span className={info.armed ? "launch-state launch-armed" : "launch-state"} data-testid="launch-state">
            <span className="live-dot" aria-hidden="true" />
            {info.armed ? (recording > 0 ? `Recording ${recording}` : "Armed") : launched ? "Disarmed" : "Off until launch"}
          </span>
        </div>
        {launched ? (
          <p className="launch-out">GTA VI is out.</p>
        ) : (
          <div role="timer" aria-label="Time until GTA VI launches">
            <dl className="countdown">
              {countdownParts(info.launchAt, now).map((p) => (
                <div key={p.unit}>
                  <dd>{p.value}</dd>
                  <dt>{p.unit}</dt>
                </div>
              ))}
            </dl>
          </div>
        )}
        {editing ? (
          <form className="launch-time" onSubmit={saveTime}>
            <label>
              Launch time, in your time zone
              <input type="datetime-local" name="launchAt" defaultValue={toLocalField(info.launchAt)} required />
            </label>
            <div className="launch-buttons">
              <button type="submit" className="primary">
                Save time
              </button>
              <button type="button" className="close" aria-label="Close without changing the time" onClick={() => setEditing(false)}>
                ×
              </button>
            </div>
          </form>
        ) : (
          <p className="launch-when">
            <span>{launched ? `Launched ${when}` : `Launches ${when}`}</span>
            <button type="button" className="link" onClick={() => setEditing(true)}>
              Change time
            </button>
          </p>
        )}
        <p className="launch-line" role="status">
          {info.statusLine}
        </p>
        <div className="launch-buttons">
          <button type="button" className="launch-arm" disabled={busy || info.armed} onClick={() => change(api.arm)}>
            Arm
          </button>
          <button type="button" disabled={busy || !info.armed} onClick={() => change(api.disarm)}>
            Disarm
          </button>
        </div>
      </div>

      <div className="launch-body">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {info.guard && (
          <p className="error" role="alert">
            {info.guard}
          </p>
        )}
        {info.creators.length === 0 ? (
          <p className="hint">
            No creator has a permission record yet, so nobody can be recorded. Join a clipping program, then{" "}
            <a href="#sources">add it as a campaign</a>.
          </p>
        ) : (
          <ul className="launch-creators">
            {info.creators.map((c) => (
              <CreatorRow key={c.creatorId} creator={c} disabled={busy} onToggle={(on) => change(() => api.setLiveCreator(c.creatorId, on))} />
            ))}
          </ul>
        )}
        {info.needPermission > 0 && (
          <p className="hint">
            {info.needPermission} more watched creators need a permission record before they can be recorded.{" "}
            <a href="#watchlist">See who</a>
          </p>
        )}
        {info.push.publicKey && (
          <div className="launch-push">
            <p className="hint">{PUSH_NOTE[push]}</p>
            {(push === "on" || push === "off") && (
              <button type="button" onClick={togglePush}>
                {push === "on" ? "Turn off notifications" : "Turn on notifications"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CreatorRow({ creator: c, disabled, onToggle }: { creator: LiveCreatorStatus; disabled: boolean; onToggle: (on: boolean) => void }) {
  const counts = [
    `${c.segments} ${c.segments === 1 ? "segment" : "segments"}`,
    `${c.clips} LIVE ${c.clips === 1 ? "clip" : "clips"}`,
    ...(c.skipped > 0 ? [`${c.skipped} skipped to keep up`] : []),
  ].join(", ");
  return (
    <li data-testid="launch-creator">
      <div className="launch-creator-text">
        <span className="launch-creator-name">
          {c.recording && <span className="live-dot" aria-hidden="true" />}
          {c.name}
        </span>
        <span className="hint">
          {c.recording ? `Recording on ${WATCH_PLATFORM_LABELS[c.live?.platform ?? "twitch"]}: ${counts}` : c.reason}
          {!c.recording && c.segments > 0 && ` (${counts})`}
        </span>
      </div>
      <label className="switch">
        <input type="checkbox" role="switch" aria-label={`Record ${c.name} live`} checked={c.on} disabled={disabled} onChange={(e) => onToggle(e.target.checked)} />
      </label>
    </li>
  );
}
