import type { ChartSeries } from "../../shared/growth";
import type { DailyPoint } from "../../shared/types";
import { compact } from "./format";

// Small hand-made SVG charts: no chart library. They stretch to their box; labels stay in HTML so
// text never scales with the drawing. Colors come from the design tokens, so both themes work.

const W = 300;
const H = 80;

function shortDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

/** A line with a soft area under it, for a count that grows (followers). */
export function LineChart({ points, label }: { points: DailyPoint[]; label: string }) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, H - 4 - ((p.value - min) / span) * (H - 8)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <figure className="chart" data-testid="growth-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${compact(values[0]!)} to ${compact(values.at(-1)!)}`}>
        <path className="chart-area" d={`${line} L${W},${H} L0,${H} Z`} />
        <path className="chart-line" d={line} />
      </svg>
      <figcaption>
        <span>{shortDay(points[0]!.date)}</span>
        <span>
          {label} {compact(min)}–{compact(max)}
        </span>
        <span>{shortDay(points.at(-1)!.date)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * Up to four lines on one scale (total views so far, per variant). Each line has its own dash
 * pattern as well as its own color, and the key under the chart repeats both with the last value,
 * so the lines can be told apart on a small screen and without color.
 */
export function LinesChart({ series, label }: { series: ChartSeries[]; label: string }) {
  const days = series[0]?.points ?? [];
  if (days.length < 2) return null;
  const max = Math.max(...series.flatMap((s) => s.points.map((p) => p.value)), 1);
  const height = 150;
  const path = (points: DailyPoint[]) =>
    points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * W).toFixed(1)},${(height - 4 - (p.value / max) * (height - 8)).toFixed(1)}`).join(" ");
  return (
    <figure className="chart lines-chart" data-testid="views-chart">
      <div className="lines-plot">
        <span className="lines-max">{compact(max)}</span>
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${series.map((s) => `${s.label} ${compact(s.points.at(-1)!.value)}`).join(", ")}`}>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} className="chart-grid" x1={0} x2={W} y1={height * f} y2={height * f} />
          ))}
          {series.map((s, i) => (
            <path key={s.key} className={`chart-line line-${i}`} d={path(s.points)} />
          ))}
        </svg>
      </div>
      <figcaption>
        <span>{shortDay(days[0]!.date)}</span>
        <span>{label}</span>
        <span>{shortDay(days.at(-1)!.date)}</span>
      </figcaption>
      <ul className="lines-key">
        {series.map((s, i) => (
          <li key={s.key}>
            <svg viewBox="0 0 28 6" aria-hidden="true">
              <path className={`chart-line line-${i}`} d="M0,3 L28,3" />
            </svg>
            {s.label}
            <b>{compact(s.points.at(-1)!.value)}</b>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** One bar per day (views per day); the latest day is drawn in the accent color. */
export function BarChart({ points, label }: { points: DailyPoint[]; label: string }) {
  if (points.length === 0) return null;
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = W / points.length;
  const gap = Math.min(2, step * 0.25);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}, last ${points.length} days, up to ${compact(max)} a day`}>
        {points.map((p, i) => {
          const h = Math.max(1, (p.value / max) * H);
          return <rect key={p.date} className={i === points.length - 1 ? "chart-bar is-last" : "chart-bar"} x={i * step} y={H - h} width={step - gap} height={h} />;
        })}
      </svg>
      <figcaption>
        <span>{shortDay(points[0]!.date)}</span>
        <span>
          {label}, top day {compact(max)}
        </span>
        <span>{shortDay(points.at(-1)!.date)}</span>
      </figcaption>
    </figure>
  );
}

/** A progress bar towards a goal, with the target as the bar's end. */
export function Meter({ value, label }: { value: number | null; label: string }) {
  const pct = value === null ? 0 : Math.round(value * 100);
  return (
    <div
      className={`meter${value !== null && value >= 1 ? " is-met" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
