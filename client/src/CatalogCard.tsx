import { useEffect, useState } from "react";
import type { CatalogInfo, ProgramListing, StreamerEntry, StreamerStatus } from "../../shared/catalog";
import { PLATFORM_LABELS } from "../../shared/types";
import { api } from "./api";
import { shortDate, usd } from "./format";

const STATUS: Record<StreamerStatus, { label: string; tone: string }> = {
  program: { label: "Pays for clips", tone: "state-approved" },
  "no-program": { label: "No program found", tone: "state-rejected" },
  gone: { label: "Proof gone", tone: "state-rejected" },
};

/** $3, $0.40, $1,000: whole amounts without cents. */
function dollars(n: number): string {
  return n.toLocaleString("en", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
}

function rate(p: ProgramListing): string {
  if (p.ratePer1kMinUsd === null) return "Each server sets its own pay";
  const range = p.ratePer1kMaxUsd !== null && p.ratePer1kMaxUsd !== p.ratePer1kMinUsd ? `${dollars(p.ratePer1kMinUsd)} to ${dollars(p.ratePer1kMaxUsd)}` : dollars(p.ratePer1kMinUsd);
  return `${range} per 1,000 views`;
}

const IMPORT_HOW: Record<ProgramListing["import"], string> = {
  scout: "Read by clipfarm every day: see Campaigns for you on the Dashboard",
  "paste-link": "Paste a campaign link above",
  "paste-text": "Paste the invite link above, then the server's rules",
};

function ProgramRow({ p }: { p: ProgramListing }) {
  const facts = [
    rate(p),
    p.capPerPostUsd !== null && `${dollars(p.capPerPostUsd)} at most per post`,
    p.minViews !== null && `paid from ${p.minViews.toLocaleString("en")} views`,
    p.earningWindowDays !== null && `earns for ${p.earningWindowDays} days`,
    p.holdDays !== null && `then held ${p.holdDays} days`,
  ].filter(Boolean);
  return (
    <li data-testid="catalog-program">
      <div className="scout-top">
        <div className="scout-name">
          <h4>{p.name}</h4>
          <span className="hint">{p.platforms.map((x) => PLATFORM_LABELS[x]).join(", ")}</span>
        </div>
        <p className="scout-day">
          <b>{p.ratePer1kMinUsd === null ? "Varies" : usd(p.perClipUsd)}</b>
          <span>{p.ratePer1kMinUsd === null ? "no public rate" : "a clip, estimate"}</span>
        </p>
      </div>
      <p className="scout-facts">
        {facts.join(", ")}.{!p.termsConfirmed && <span className="hint"> Reported terms, not confirmed by the program.</span>}
      </p>
      <p className="hint">{p.note}</p>
      <details className="scout-why">
        <summary>How the estimate is made</summary>
        <p>{p.estimateWhy}</p>
        <p>
          Terms from{" "}
          <a href={p.factsUrl} target="_blank" rel="noreferrer">
            this page
          </a>
          , read on {shortDate(p.checkedOn)}.
        </p>
      </details>
      <div className="actions">
        <a className="button" href={p.url} target="_blank" rel="noreferrer">
          Open {p.name.split(" (")[0]}
        </a>
        <span className="hint">{IMPORT_HOW[p.import]}</span>
      </div>
    </li>
  );
}

function StreamerRow({ s, checking, onCheck }: { s: StreamerEntry; checking: boolean; onCheck: () => void }) {
  const st = STATUS[s.status];
  return (
    <li data-testid="catalog-streamer">
      <div className="scout-top">
        <div className="scout-name">
          <h4>{s.name}</h4>
          <span className="hint">{s.program ?? (s.status === "program" ? "" : "Their clips go only to burner accounts.")}</span>
        </div>
        <span className={`chip-state ${st.tone}`}>{st.label}</span>
      </div>
      <p className="scout-facts">
        {s.proofUrl && (
          <>
            <a href={s.proofUrl} target="_blank" rel="noreferrer">
              Proof
            </a>
            {". "}
          </>
        )}
        Checked {shortDate(s.checkedAt)}, next check {shortDate(s.nextCheckAt)}. {s.lastResult}
      </p>
      {s.note && <p className="hint">{s.note}</p>}
      <div className="actions">
        <button type="button" disabled={checking} onClick={onCheck}>
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
    </li>
  );
}

/**
 * "Where clips earn" on Sources: every program that pays for clips, ranked by what one of our clips
 * should earn there, and the streamer registry (who pays for clips, with proof, and who has no program).
 */
export function CatalogCard() {
  const [info, setInfo] = useState<CatalogInfo | null>(null);
  const [view, setView] = useState<"programs" | "streamers">("programs");
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.catalog().then(setInfo, () => undefined);
  }, []);
  if (!info) return null;

  const check = (name: string) => {
    setChecking(name);
    setError(null);
    api
      .checkStreamer(name)
      .then(setInfo, (err: Error) => setError(err.message))
      .finally(() => setChecking(null));
  };

  return (
    <div className="card scout catalog" data-testid="catalog">
      <div className="card-head">
        <h3>Where clips earn</h3>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Show">
        {(["programs", "streamers"] as const).map((v) => (
          <label key={v} className={view === v ? "on" : undefined}>
            <input type="radio" name="catalog-view" value={v} checked={view === v} onChange={() => setView(v)} />
            {v === "programs" ? `Programs (${info.programs.length})` : `Streamers (${info.streamers.length})`}
          </label>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view === "programs" ? (
        <>
          <p className="hint">Programs that pay per view, best first by what one of our clips should earn (their pay × our usual views).</p>
          <ol className="scout-list">
            {info.programs.map((p) => (
              <ProgramRow key={p.id} p={p} />
            ))}
          </ol>
        </>
      ) : (
        <>
          <p className="hint">Creators who publicly pay for clips, with proof, checked again every 7 days. Creators with no program are never clipped for main accounts.</p>
          <ol className="scout-list catalog-streamers">
            {info.streamers.map((s) => (
              <StreamerRow key={s.name} s={s} checking={checking === s.name} onCheck={() => check(s.name)} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
