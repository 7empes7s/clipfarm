import { useCallback, useEffect, useState } from "react";
import type { EngineSettings, EngineStatus, EngineStepStatus, Job } from "../../shared/types";
import { api } from "./api";
import { Meter } from "./charts";

const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

/** The engine that transcribes and picks: ready, or exactly what is missing with a button to fetch it. */
export function EngineCard({ jobs }: { jobs: Job[] }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.engine().then(setStatus, (err: Error) => setError(err.message)), []);
  // The app polls the job list; follow the download through it.
  const setupKey = jobs
    .filter((j) => j.type === "engine-setup")
    .map((j) => `${j.id}:${j.status}:${Math.round(j.progress * 100)}:${j.message}`)
    .join(",");
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load, setupKey]);

  if (!status) {
    return error ? (
      <p className="error" role="alert">
        {error}
      </p>
    ) : null;
  }

  const act = (work: Promise<EngineStatus>) => {
    setBusy(true);
    setError(null);
    void work.then(setStatus, (err: Error) => setError(err.message)).finally(() => setBusy(false));
  };
  const save = (change: Partial<EngineSettings>) => act(api.saveEngineSettings(change));
  const job = status.setupJob;
  const downloading = job !== null && job.status !== "failed";
  const total = status.downloads.reduce((sum, d) => sum + d.bytes, 0);
  const order = status.settings.stt;
  /** Moves a step one place up or down the chain. */
  const move = (index: number, by: -1 | 1) => {
    const next = [...order];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    save({ stt: next });
  };
  const stepState = (s: EngineStepStatus) =>
    !s.on ? "Off" : s.state === "ready" ? "Ready" : s.state === "missing" ? "Missing" : s.id === "cloud" ? "No key" : "Waiting";

  return (
    <section className="card engine" aria-labelledby="engine-title" data-testid="engine">
      <div className="card-head">
        <h3 id="engine-title">{status.headline}</h3>
        <span className={`state ${status.ready ? "state-active" : "state-none"}`}>{status.ready ? "Ready" : "Not ready"}</span>
      </div>
      {status.mode === "local" && status.ready && (
        <p className="hint">Transcripts and picks are made on this server. No outside AI service, no cost per minute.</p>
      )}
      {status.problems.length > 0 && (
        <ul className="engine-problems">
          {status.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {downloading && (
        <div role="status">
          <Meter value={job.progress} label="Engine download progress" />
          <span className="hint">{job.status === "queued" ? "Waiting for the running job to finish" : job.message}</span>
        </div>
      )}
      {job?.status === "failed" && (
        <p className="error" role="alert">
          {job.error}
        </p>
      )}
      {!downloading && status.downloads.length > 0 && (
        <button type="button" className="primary" disabled={busy} onClick={() => act(api.setupEngine())}>
          Set up the local engine ({size(total)} download)
        </button>
      )}
      {status.mode !== "test" && (
        <div className="engine-settings">
          <h4 id="engine-chain-title">Speech-to-text, in this order</h4>
          <p className="hint">The first step that can take a part of the stream does it. A part that fails, takes too long or comes back poor goes to the next step.</p>
          <ol className="engine-chain" aria-labelledby="engine-chain-title">
            {status.steps.map((s, i) => (
              <li key={s.id} className="engine-step" data-testid={`engine-step-${s.id}`}>
                <div className="card-head">
                  <strong>
                    {i + 1}. {s.label}
                  </strong>
                  <span className={`state ${s.on && s.state === "ready" ? "state-active" : s.on ? "state-none" : "state-off"}`}>{stepState(s)}</span>
                </div>
                <p className="hint">{s.note}</p>
                {s.on && s.problem && <p className="hint">{s.problem}</p>}
                <p className="hint">
                  {s.speed === null ? "Speed on this server: not measured yet" : `Speed on this server: ${s.speed} s of stream per second`}
                </p>
                <div className="engine-step-actions">
                  <label className="switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={s.on}
                      disabled={busy || (s.id === "cloud" && !s.on && !status.cloudAvailable)}
                      aria-label={s.id === "cloud" ? "Fall back to cloud AI" : `Use ${s.label}`}
                      onChange={(e) => save({ stt: order.map((x) => (x.id === s.id ? { ...x, on: e.target.checked } : x)) })}
                    />
                    {s.id === "cloud" ? "Fall back to cloud AI" : "Use"}
                  </label>
                  <button type="button" disabled={busy || i === 0} aria-label={`Move ${s.label} earlier`} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" disabled={busy || i === status.steps.length - 1} aria-label={`Move ${s.label} later`} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  {s.state === "missing" && !downloading && (
                    <button type="button" disabled={busy} onClick={() => act(api.setupEngine(s.id))}>
                      Download ({size(s.downloadBytes)})
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <h4>Last 7 days</h4>
          {status.week.lines.length === 0 ? (
            <p className="hint">No streams transcribed yet. Once there are, this says how often each step and each fallback was used.</p>
          ) : (
            <ul className="engine-week" data-testid="engine-week">
              {status.week.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <label>
            Speech model for the Whisper English step
            <select value={status.settings.sttModel} disabled={busy || status.settings.cloud} onChange={(e) => save({ sttModel: e.target.value })}>
              {status.sttModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} ({size(m.bytes)})
                </option>
              ))}
            </select>
          </label>
          <p className="hint">{status.sttModels.find((m) => m.id === status.settings.sttModel)?.note}</p>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={status.settings.writer}
              disabled={busy || status.settings.cloud}
              onChange={(e) => save({ writer: e.target.checked })}
            />
            Write hooks with the local writer
          </label>
          <p className="hint">Off: hooks are the line said at the peak. On: a small model on this server writes them (1.1 GB download, about 8 more minutes per stream).</p>
          {status.writerNote && <p className="hint">Right now hooks would come from the transcript. {status.writerNote}</p>}
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={status.settings.cloud}
              disabled={busy || (!status.cloudAvailable && !status.settings.cloud)}
              onChange={(e) => save({ cloud: e.target.checked })}
            />
            Use cloud AI for speed
          </label>
          {!status.cloudAvailable && <p className="hint">Needs an OpenAI key (add it in Settings). Without one, everything runs locally.</p>}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
