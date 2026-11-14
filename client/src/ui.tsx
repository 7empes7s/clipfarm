import type { ReactNode } from "react";
import { ringDash, sparkPath } from "./spark";

// The small shared pieces of clipfarm's look: the logo, the icons, empty screens that say what to
// do next, loading shapes, sparklines and the progress ring. Colours come from the design tokens.

/** The mark: two trim handles around a play triangle. Same shapes as the app icon. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect className="logo-tile" width="512" height="512" rx="116" />
      <g className="logo-mark">
        <rect x="108" y="128" width="48" height="256" rx="24" />
        <rect x="356" y="128" width="48" height="256" rx="24" />
        <path d="M218 208v96a14 14 0 0 0 21 12l72-48a14 14 0 0 0 0-24l-72-48a14 14 0 0 0-21 12z" />
      </g>
    </svg>
  );
}

const ICONS = {
  dashboard: "M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z",
  inbox: "M4 13l2.5-8h11L20 13v6H4zM4 13h4.5l1 2.5h5l1-2.5H20",
  approved: "M5 12.5l4.5 4.5L19 7.5",
  posted: "M4 12l16-7-6 15-3-6z",
  sources: "M4 6h16v12H4zM4 10h16M9 14h3",
  watchlist: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  jobs: "M4 7h10M18 7h2M4 12h3M11 12h9M4 17h12M20 17h0M14 5v4M7 10v4M16 15v4",
  stats: "M5 20V11M12 20V4M19 20v-6",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
  reject: "M6 6l12 12M18 6L6 18",
  edit: "M5 19l1-4L16.5 4.5l3 3L9 18zM14.5 6.5l3 3",
  approve: "M5 12.5l4.5 4.5L19 7.5",
  sound: "M4 10v4h3.5L12 18V6L7.5 10zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
  muted: "M4 10v4h3.5L12 18V6L7.5 10zM16 9.5l5 5M21 9.5l-5 5",
  play: "M8 5.5v13l10.5-6.5z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.5l3 1.5",
  campaigns: "M4 19V10M10 19V5M16 19v-8M4 10l6-5 6 6 4-4",
  calendar: "M5 6h14v14H5zM5 10h14M9 4v4M15 4v4",
} as const;
export type IconName = keyof typeof ICONS;

/** A line icon, drawn in the text colour around it. Always decorative: the words beside it carry the meaning. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

interface Action {
  label: string;
  href?: string;
  onClick?: () => void;
}

/** An empty screen: what is missing, what to do next, and one primary button that does it. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  extra,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: Action;
  /** A quieter second option, under the primary button. */
  extra?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <p className="empty-title">{title}</p>
      <p className="empty-line">{children}</p>
      {action &&
        (action.href ? (
          <a className="button primary" href={action.href}>
            {action.label}
          </a>
        ) : (
          <button type="button" className="primary" onClick={action.onClick}>
            {action.label}
          </button>
        ))}
      {extra}
    </div>
  );
}

/** Grey shapes in the place of content that is still loading, so nothing jumps when it arrives. */
export function Skeleton({ shape, count = 1 }: { shape: "tiles" | "card" | "frame" | "rows"; count?: number }) {
  if (shape === "frame")
    return (
      <div className="review" role="status" aria-label="Loading">
        <div className="frame skel" />
      </div>
    );
  if (shape === "tiles")
    return (
      <div className="tiles" role="status" aria-label="Loading">
        <div className="tile tile-hero tile-lead skel" />
        <div className="tile tile-hero skel" />
        <div className="tile tile-hero skel" />
        <div className="tile skel" />
        <div className="tile skel" />
      </div>
    );
  return (
    <div className="stack" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skel skel-${shape}`} />
      ))}
    </div>
  );
}

/** A week at a glance under a big number. Decorative: the number beside it is the fact. */
export function Sparkline({ values }: { values: number[] }) {
  // A week of zeros is no trend yet: leave the space empty rather than draw a flat line.
  const d = values.some((v) => v !== 0) ? sparkPath(values, 100, 28, 3) : "";
  if (!d) return null;
  return (
    <svg className="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <path className="spark-area" d={`${d} L100,28 L0,28 Z`} />
      <path className="spark-line" d={d} />
    </svg>
  );
}

/** A ring that fills as steps get done, with the count in the middle. */
export function Ring({ done, total, label }: { done: number; total: number; label: string }) {
  const r = 26;
  const { dash, gap } = ringDash(done, total, r);
  return (
    <div className="ring" role="img" aria-label={label}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle className="ring-track" cx="32" cy="32" r={r} />
        <circle className="ring-fill" cx="32" cy="32" r={r} strokeDasharray={`${dash} ${gap}`} transform="rotate(-90 32 32)" />
      </svg>
      <span aria-hidden="true">
        {done}/{total}
      </span>
    </div>
  );
}

/** A creator's initials on one of four tones, picked by their name so it never changes. */
export function Avatar({ name, live = false }: { name: string; live?: boolean }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const tone = [...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 4;
  return (
    <span className={`face tone-${tone}${live ? " is-live" : ""}`} aria-hidden="true">
      {initials}
    </span>
  );
}
