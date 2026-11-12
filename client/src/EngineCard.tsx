import { useCallback, useEffect, useState } from "react";
import type { EngineSettings, EngineStatus, Job } from "../../shared/types";
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
          <label>
            Speech model
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
