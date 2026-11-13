import { useEffect, useState } from "react";
import type { LiveVersion } from "../../shared/types";
import { api } from "./api";
import { ago } from "./format";

const RESULT_LABEL = { live: "Live", "rolled back": "Rolled back", failed: "Not built" } as const;
const POSTIZ_LABEL = { healthy: "Healthy", "not healthy": "Not healthy", "not installed": "Not installed" } as const;

/** Which version runs on the server, and what the checks after the last update said. Hidden where nothing deploys by itself. */
export function LiveVersionCard() {
  const [version, setVersion] = useState<LiveVersion | null>(null);

  useEffect(() => {
    // A card that cannot load says nothing: the rest of the dashboard does not depend on it.
    const load = () => void api.liveVersion().then(setVersion, () => undefined);
    const first = setTimeout(load, 0);
    const again = setInterval(load, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, []);

  if (!version) return null;

  const rows: { name: string; state: string; ok: boolean }[] = [
    { name: "Site check", state: version.check.ok ? "OK" : "Problem", ok: version.check.ok },
    { name: "Postiz", state: POSTIZ_LABEL[version.postiz.state], ok: version.postiz.state === "healthy" },
    ...version.keys.filter((k) => k.state !== "Not set").map((k) => ({ name: k.name, state: k.state, ok: k.state === "Working" })),
  ];
  const problems = [...version.check.problems, ...(version.postiz.detail ? [`Postiz: ${version.postiz.detail}`] : [])];

  return (
    <section className="card live-version" aria-labelledby="live-version-title" data-testid="live-version">
      <div className="card-head">
        <h3 id="live-version-title">Live version</h3>
        <span className={`state ${version.result === "live" ? "state-active" : "state-none"}`}>{RESULT_LABEL[version.result]}</span>
      </div>
      <p className="hint">
        {version.result === "live" ? "Version" : "Update"} <code>{version.sha.slice(0, 7)}</code>, {ago(version.at)}. New versions go live by themselves once their checks pass.
      </p>
      {version.reason && (
        <p className="error" role="alert">
          {version.reason}
        </p>
      )}
      <ul className="live-version-rows">
        {rows.map((r) => (
          <li key={r.name} className={`job-line ${r.ok ? "job-done" : "job-failed"}`}>
            <span className="job-name">{r.name}</span>
            <span className="job-status">{r.state}</span>
          </li>
        ))}
      </ul>
      {problems.length > 0 && (
        <ul className="engine-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
