import type {
  Clip,
  ClipEditInput,
  FaceCam,
  ExportPack,
  Job,
  NewSourceInput,
  Pick,
  Platform,
  RejectReason,
  Post,
  PostingInfo,
  PostingRules,
  Source,
  Stats,
  Vod,
  VodDetail,
  WatchedCreator,
  WatchedCreatorInput,
  Watchlist,
} from "../../shared/types";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}.`);
  return body;
}

export const api = {
  sources: () => call<Source[]>("/api/sources"),
  addSource: (input: NewSourceInput) => call<Source>("/api/sources", { method: "POST", body: JSON.stringify(input) }),
  vods: () => call<Vod[]>("/api/vods"),
  vod: (id: number) => call<VodDetail>(`/api/vods/${id}`),
  addVod: (sourceId: number, url: string) =>
    call<{ vod: Vod; job: Job }>("/api/vods", { method: "POST", body: JSON.stringify({ sourceId, url }) }),
  jobs: () => call<Job[]>("/api/jobs"),
  picks: () => call<Pick[]>("/api/picks"),
  cancelJob: (id: number) => call<Job>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  retryJob: (id: number) => call<Job>(`/api/jobs/${id}/retry`, { method: "POST" }),
  clips: () => call<Clip[]>("/api/clips"),
  approveClip: (id: number) => call<Clip>(`/api/clips/${id}/approve`, { method: "POST" }),
  rejectClip: (id: number, reason: RejectReason | null = null) =>
    call<Clip>(`/api/clips/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }),
  undoReview: () => call<Clip>("/api/clips/undo", { method: "POST" }),
  editClip: (id: number, edit: ClipEditInput) =>
    call<{ clip: Clip; job: Job }>(`/api/clips/${id}/edit`, { method: "POST", body: JSON.stringify(edit) }),
  setFaceCam: (sourceId: number, faceCam: FaceCam | null) =>
    call<Source>(`/api/sources/${sourceId}/face-cam`, { method: "PUT", body: JSON.stringify(faceCam ?? { clear: true }) }),
  loadDemo: () => call<Job>("/api/demo", { method: "POST" }),
  exportPack: (id: number, platform: Platform) => call<ExportPack>(`/api/clips/${id}/export?platform=${platform}`),
  postClip: (id: number, accountIds: string[], when: string | null) =>
    call<Post[]>(`/api/clips/${id}/posts`, { method: "POST", body: JSON.stringify({ accountIds, when }) }),
  posting: () => call<PostingInfo>("/api/posting"),
  saveRules: (rules: PostingRules) => call<PostingRules>("/api/posting/rules", { method: "PUT", body: JSON.stringify(rules) }),
  posts: () => call<Post[]>("/api/posts"),
  refreshPosts: () => call<{ updated: number; error: string | null }>("/api/posts/refresh", { method: "POST" }),
  setViews: (id: number, views: number) => call<Post>(`/api/posts/${id}/views`, { method: "POST", body: JSON.stringify({ views }) }),
  markWhop: (id: number) => call<Post>(`/api/posts/${id}/whop`, { method: "POST" }),
  stats: () => call<Stats>("/api/stats"),
  watchlist: () => call<Watchlist>("/api/watchlist"),
  checkWatchlist: () => call<Watchlist>("/api/watchlist/poll", { method: "POST" }),
  addWatched: (input: WatchedCreatorInput) => call<WatchedCreator>("/api/watchlist", { method: "POST", body: JSON.stringify(input) }),
  updateWatched: (id: number, input: WatchedCreatorInput) =>
    call<WatchedCreator>(`/api/watchlist/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  removeWatched: (id: number) => call<unknown>(`/api/watchlist/${id}`, { method: "DELETE" }),
  setAutoIngest: (id: number, on: boolean) =>
    call<WatchedCreator>(`/api/watchlist/${id}/auto-ingest`, { method: "PUT", body: JSON.stringify({ on }) }),
};
