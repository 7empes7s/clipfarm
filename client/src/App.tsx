import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Job, Pick, Source, Vod, VodDetail } from "../../shared/types";
import { PERMISSION_KIND_LABELS, PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { CampaignForm } from "./CampaignForm";
import { Clips } from "./Clips";
import { FaceCamEditor } from "./FaceCamEditor";
import { clock, shortDate, usd } from "./format";

const STATE_LABEL = { active: "Allowed", expired: "Expired", none: "No permission" } as const;
const VOD_STATUS_LABEL: Record<Vod["status"], string> = {
  queued: "Waiting",
  downloading: "Downloading audio",
  transcribing: "Transcribing",
  ready: "Transcript ready",
  failed: "Failed",
};
const JOB_TYPE_LABEL: Record<string, string> = {
  ingest: "Transcript",
  picks: "Picking highlights",
  render: "Cutting a clip",
};
const JOB_STATUS_LABEL: Record<Job["status"], string> = {
  queued: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [vods, setVods] = useState<Vod[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, v, j, p] = await Promise.all([api.sources(), api.vods(), api.jobs(), api.picks()]);
      setSources(s);
      setVods(v);
      setJobs(j);
      setPicks(p);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  const busy = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    // Refresh now, then poll: every second while a job is working, else every 5 s.
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), busy ? 1000 : 5000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh, busy]);

  const closeForm = useCallback(() => setFormOpen(false), []);

  return (
    <div className="page">
      <header className="masthead">
        <h1>
          <span className="tally" aria-hidden="true" />
          clipfarm
        </h1>
        <p>Streams in, vertical clips out. Only from creators who said yes.</p>
      </header>

      {loadError && (
        <p className="error" role="alert">
          Could not reach the server: {loadError}
        </p>
      )}

      <section aria-labelledby="campaigns-title">
        <div className="section-head">
          <h2 id="campaigns-title">Campaigns</h2>
          <button type="button" className="primary" onClick={() => setFormOpen(true)}>
            Add a campaign
          </button>
        </div>
        {sources.length === 0 ? (
          <p className="empty">
            No campaigns yet. Add one from a clipping program (like Whop Content Rewards) before adding any stream.
          </p>
        ) : (
          <ul className="stack">
            {sources.map((s) => (
              <SourceCard
                key={s.id}
                source={s}
                vods={vods.filter((v) => v.sourceId === s.id)}
                picks={picks}
                onChange={refresh}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="jobs-title">
        <h2 id="jobs-title">Work queue</h2>
        <p className="hint">One job at a time, so the server stays light.</p>
        {jobs.length === 0 ? (
          <p className="empty">Nothing running. Add a stream link to a campaign to start.</p>
        ) : (
          <ul className="jobs">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} vod={vods.find((v) => v.id === j.vodId)} onChange={refresh} />
            ))}
          </ul>
        )}
      </section>

      {formOpen && (
        <CampaignForm
          onClose={closeForm}
          onSaved={() => {
            setFormOpen(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function SourceCard({
  source,
  vods,
  picks,
  onChange,
}: {
  source: Source;
  vods: Vod[];
  picks: Pick[];
  onChange: () => void;
}) {
  const perm = source.permissions.at(-1);
  const [url, setUrl] = useState("");
  const [faceCamOpen, setFaceCamOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addVod(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.addVod(source.id, url);
      setUrl("");
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <li className="card" data-testid="campaign">
      <div className="card-head">
        <h3>{source.creatorName}</h3>
        <span className={`state state-${source.permissionState}`}>{STATE_LABEL[source.permissionState]}</span>
      </div>
      {perm && (
        <dl className="stub">
          <div>
            <dt>Via</dt>
            <dd>
              {perm.campaignUrl ? (
                <a href={perm.campaignUrl} target="_blank" rel="noreferrer">
                  {PERMISSION_KIND_LABELS[perm.kind]}
                </a>
              ) : (
                PERMISSION_KIND_LABELS[perm.kind]
              )}
            </dd>
          </div>
          {perm.cpmRateUsd !== null && (
            <div>
              <dt>Pays</dt>
              <dd>{usd(perm.cpmRateUsd)} per 1k views</dd>
            </div>
          )}
          {perm.minViews !== null && (
            <div>
              <dt>Minimum</dt>
              <dd>{perm.minViews.toLocaleString()} views</dd>
            </div>
          )}
          <div>
            <dt>Ends</dt>
            <dd>{perm.expiresAt ? shortDate(perm.expiresAt) : "No end date"}</dd>
          </div>
          <div className="wide">
            <dt>Post to</dt>
            <dd>{perm.allowedPlatforms.map((p) => PLATFORM_LABELS[p]).join(", ")}</dd>
          </div>
        </dl>
      )}
      {source.bannedContent && <p className="banned">Off limits: {source.bannedContent}</p>}
      <div className="facecam-line">
        <span className="hint">
          {source.faceCam
            ? "Face cam set: clips show it on top."
            : source.hasFrame
              ? "No face cam set: clips show the game only."
              : "You can mark their face cam once the first clip is cut."}
        </span>
        {source.hasFrame && (
          <button type="button" className="link" onClick={() => setFaceCamOpen(true)}>
            {source.faceCam ? "Change face cam" : "Mark face cam"}
          </button>
        )}
      </div>

      {source.permissionState === "active" ? (
        <form className="add-vod" onSubmit={addVod}>
          <label htmlFor={`vod-url-${source.id}`}>Stream or video link</label>
          <div className="inline">
            <input
              id={`vod-url-${source.id}`}
              type="url"
              inputMode="url"
              required
              placeholder="https://www.twitch.tv/videos/…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit">Add</button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <p className="blocked">
          {source.permissionState === "expired" ? "This permission has expired." : "There is no permission yet."} Add a
          current campaign before adding streams.
        </p>
      )}

      {vods.length > 0 && (
        <ul className="vods">
          {vods.map((v) => (
            <VodRow key={v.id} vod={v} picks={picks.filter((p) => p.vodId === v.id)} />
          ))}
        </ul>
      )}
      {faceCamOpen && (
        <FaceCamEditor
          source={source}
          onClose={() => setFaceCamOpen(false)}
          onSaved={() => {
            setFaceCamOpen(false);
            onChange();
          }}
        />
      )}
    </li>
  );
}

function VodRow({ vod, picks }: { vod: Vod; picks: Pick[] }) {
  const [detail, setDetail] = useState<VodDetail | null>(null);
  const [open, setOpen] = useState(false);

  async function toggle() {
    if (!open && (!detail || detail.wordCount !== vod.wordCount)) setDetail(await api.vod(vod.id));
    setOpen(!open);
  }

  return (
    <li className="vod" data-testid="vod">
      <div className="vod-title">{vod.title ?? vod.url}</div>
      <div className="meta">
        <span className={`vod-status vod-${vod.status}`}>{VOD_STATUS_LABEL[vod.status]}</span>
        {vod.durationSec !== null && <span>{clock(vod.durationSec)}</span>}
        {vod.status === "ready" && <span>{vod.wordCount} words</span>}
        {vod.transcriptCostUsd !== null && <span>cost {usd(vod.transcriptCostUsd)}</span>}
      </div>
      {vod.status === "ready" && (
        <button type="button" className="link" aria-expanded={open} onClick={() => void toggle()}>
          {open ? "Hide transcript" : "Show transcript"}
        </button>
      )}
      {open && detail && (
        <p className="transcript" data-testid="transcript">
          {detail.words.map((w, i) => (
            <span key={i} title={clock(w.startSec)}>
              {i % 20 === 0 && <time>{clock(w.startSec)}</time>}
              {w.word}{" "}
            </span>
          ))}
        </p>
      )}
      <Clips picks={picks} />
    </li>
  );
}

function JobRow({ job, vod, onChange }: { job: Job; vod?: Vod; onChange: () => void }) {
  const active = job.status === "queued" || job.status === "running";
  return (
    <li className={`job job-${job.status}`} data-testid="job">
      <div className="job-line">
        <span className="job-name">
          {JOB_TYPE_LABEL[job.type] ?? job.type}: {vod?.title ?? vod?.url ?? `job ${job.id}`}
        </span>
        <span className="job-status">{JOB_STATUS_LABEL[job.status]}</span>
      </div>
      {active && (
        <div className="bar" role="progressbar" aria-valuenow={Math.round(job.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
      )}
      <div className="job-line">
        <span className="hint">{job.error ?? (active ? job.message : "")}</span>
        {active && (
          <button
            type="button"
            className="link"
            onClick={() => {
              void api.cancelJob(job.id).then(onChange);
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}
