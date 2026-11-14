// Creator mode: workspaces, your own videos in (uploads and links) and the formats made from them.

/** The workspace every install starts with: our own channels. */
export const MY_WORKSPACE_ID = 1;

/** A brand template: what every output of a workspace carries. */
export interface Brand {
  /** "@handle" or a short sign-off added to descriptions. */
  handle: string;
  /** Caption highlight colour, as #rrggbb. */
  color: string;
  /** A closing line for descriptions ("Full episode on the channel"). */
  callToAction: string;
}

export const DEFAULT_BRAND: Brand = { handle: "", color: "#ffd84d", callToAction: "" };

/** Me, or a client: its own sources, brand, connected accounts and stats. No billing yet. */
export interface Workspace {
  id: number;
  name: string;
  brand: Brand;
  createdAt: string;
}

export interface WorkspaceStats {
  sources: number;
  videos: number;
  clipsWaiting: number;
  clipsApproved: number;
  posts: number;
  views: number;
  accounts: number;
}

export interface WorkspaceSummary extends Workspace {
  stats: WorkspaceStats;
}

/** What a pasted link is. A channel or feed is watched for new videos; the rest is one video. */
export const LINK_KINDS = ["youtube-video", "youtube-channel", "twitch-vod", "twitch-channel", "kick-vod", "kick-channel", "podcast-feed", "drive", "dropbox", "file"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  "youtube-video": "YouTube video",
  "youtube-channel": "YouTube channel",
  "twitch-vod": "Twitch video",
  "twitch-channel": "Twitch channel",
  "kick-vod": "Kick video",
  "kick-channel": "Kick channel",
  "podcast-feed": "Podcast feed",
  drive: "Google Drive file",
  dropbox: "Dropbox file",
  file: "Video file link",
};

/** A resumable upload: the phone sends the file in pieces, and asks where to carry on after a drop. */
export interface Upload {
  id: number;
  fileName: string;
  sizeBytes: number;
  receivedBytes: number;
  status: "receiving" | "done";
  vodId: number | null;
}

/** Each piece of an upload is at most this big. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** The biggest file taken: 20 GB (a few hours of 1080p). */
export const UPLOAD_MAX_BYTES = 20 * 1024 ** 3;

export const OUTPUT_FORMATS = ["short", "square", "wide", "best-of", "audiogram"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const OUTPUT_FORMAT_LABELS: Record<OutputFormat, string> = {
  short: "Short 9:16",
  square: "Square 1:1",
  wide: "Wide 16:9",
  "best-of": "Best of",
  audiogram: "Audiogram",
};

export interface TimeRange {
  startSec: number;
  endSec: number;
}

export interface OutputChapter {
  title: string;
  startSec: number;
}

/** One finished (or waiting) output of a long video, with its suggested title, description and chapters. */
export interface Output {
  id: number;
  vodId: number;
  sourceId: number;
  format: OutputFormat;
  ranges: TimeRange[];
  status: "waiting" | "done" | "failed";
  error: string | null;
  durationSec: number | null;
  title: string;
  description: string;
  chapters: OutputChapter[];
  videoUrl: string | null;
  thumbUrl: string | null;
  createdAt: string;
}

/** The Creator screen: the workspace's own-content sources with their videos, watched channels and outputs. */
export interface CreatorInfo {
  workspace: Workspace;
  outputs: Output[];
}
