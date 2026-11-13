import type {
  AccountChoice,
  AccountsInfo,
  AllowanceFind,
  CampaignDraft,
  ChannelSettings,
  Clip,
  Dashboard,
  ClipEditInput,
  EngineSettings,
  EngineStatus,
  FaceCam,
  ExportPack,
  Job,
  LiveInfo,
  NewPermissionInput,
  NewSourceInput,
  Pick,
  Platform,
  RejectReason,
  IntegrationId,
  SettingsInfo,
  SetupChecklist,
  Post,
  PostFlag,
  PostingInfo,
  PostingRules,
  PostOutcome,
  Source,
  Stats,
  SuggestedCreator,
  Vod,
  VodDetail,
  WatchChannel,
  WatchedCreator,
  WatchedCreatorInput,
  Watchlist,
  WhopStep,
} from "../../shared/types";
import type { ClipThumbs, GoogleSettings, GoogleStatus } from "../../shared/google";

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
  readCampaign: (url: string, text?: string) =>
    call<CampaignDraft>("/api/campaigns/read", { method: "POST", body: JSON.stringify({ url, text }) }),
  saveCampaign: (input: NewSourceInput) => call<Source>("/api/campaigns", { method: "POST", body: JSON.stringify(input) }),
  suggested: () => call<SuggestedCreator[]>("/api/sources/suggested"),
  addSuggested: (names: string[]) =>
    call<{ added: Source[]; suggested: SuggestedCreator[] }>("/api/sources/suggested", { method: "POST", body: JSON.stringify({ names }) }),
  checkPermission: (id: number) => call<{ ok: boolean; message: string; source: Source }>(`/api/permissions/${id}/check`, { method: "POST" }),
  findAllowance: (channels: WatchChannel[]) =>
    call<AllowanceFind>("/api/allowance/find", { method: "POST", body: JSON.stringify({ channels }) }),
  addPermission: (sourceId: number, input: NewPermissionInput) =>
    call<Source>(`/api/sources/${sourceId}/permissions`, { method: "POST", body: JSON.stringify(input) }),
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
  fixClip: (id: number) => call<{ clip: Clip; job: Job }>(`/api/clips/${id}/fix`, { method: "POST" }),
  setFaceCam: (sourceId: number, faceCam: FaceCam | null) =>
    call<Source>(`/api/sources/${sourceId}/face-cam`, { method: "PUT", body: JSON.stringify(faceCam ?? { clear: true }) }),
  loadDemo: () => call<Job>("/api/demo", { method: "POST" }),
  exportPack: (id: number, platform: Platform) => call<ExportPack>(`/api/clips/${id}/export?platform=${platform}`),
  postClip: (id: number, accountIds: string[], when: string | null) =>
    call<PostOutcome>(`/api/clips/${id}/posts`, { method: "POST", body: JSON.stringify({ accountIds, when }) }),
  clipAccounts: (id: number) => call<AccountChoice[]>(`/api/clips/${id}/accounts`),
  posting: () => call<PostingInfo>("/api/posting"),
  saveRules: (rules: PostingRules) => call<PostingRules>("/api/posting/rules", { method: "PUT", body: JSON.stringify(rules) }),
  posts: () => call<Post[]>("/api/posts"),
  refreshPosts: () => call<{ updated: number; error: string | null }>("/api/posts/refresh", { method: "POST" }),
  setViews: (id: number, views: number) => call<Post>(`/api/posts/${id}/views`, { method: "POST", body: JSON.stringify({ views }) }),
  markWhop: (id: number, step: WhopStep, on: boolean) =>
    call<Post>(`/api/posts/${id}/whop`, { method: "POST", body: JSON.stringify({ step, on }) }),
  flagPost: (id: number, flag: PostFlag, on: boolean) =>
    call<Post>(`/api/posts/${id}/flags`, { method: "POST", body: JSON.stringify({ flag, on }) }),
  stats: () => call<Stats>("/api/stats"),
  dashboard: () => call<Dashboard>("/api/dashboard"),
  accounts: () => call<AccountsInfo>("/api/accounts"),
  syncAccounts: () => call<AccountsInfo>("/api/accounts/sync", { method: "POST" }),
  saveAccount: (accountId: string, settings: ChannelSettings) =>
    call<AccountsInfo>(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "PUT", body: JSON.stringify(settings) }),
  setFollowers: (accountId: string, followers: number) =>
    call<AccountsInfo>(`/api/accounts/${encodeURIComponent(accountId)}/followers`, { method: "POST", body: JSON.stringify({ followers }) }),
  engine: () => call<EngineStatus>("/api/engine"),
  /** Fetches what the engine misses; with a step, only that step's files. */
  setupEngine: (step?: string) => call<EngineStatus>("/api/engine/setup", { method: "POST", body: JSON.stringify(step ? { step } : {}) }),
  saveEngineSettings: (change: Partial<EngineSettings>) =>
    call<EngineStatus>("/api/engine/settings", { method: "PUT", body: JSON.stringify(change) }),
  google: () => call<GoogleStatus>("/api/google"),
  saveGoogleSettings: (change: Partial<GoogleSettings>) => call<GoogleStatus>("/api/google/settings", { method: "PUT", body: JSON.stringify(change) }),
  clipThumbs: (clipId: number) => call<ClipThumbs>(`/api/clips/${clipId}/thumbnails`),
  makeThumbs: (clipId: number) => call<ClipThumbs>(`/api/clips/${clipId}/thumbnails`, { method: "POST" }),
  chooseThumb: (id: number) => call<ClipThumbs>(`/api/thumbnails/${id}/choose`, { method: "POST" }),
  loadDemoData: () => call<Job>("/api/demo-data", { method: "POST" }),
  watchlist: () => call<Watchlist>("/api/watchlist"),
  checkWatchlist: () => call<Watchlist>("/api/watchlist/poll", { method: "POST" }),
  addWatched: (input: WatchedCreatorInput) => call<WatchedCreator>("/api/watchlist", { method: "POST", body: JSON.stringify(input) }),
  updateWatched: (id: number, input: WatchedCreatorInput) =>
    call<WatchedCreator>(`/api/watchlist/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  removeWatched: (id: number) => call<unknown>(`/api/watchlist/${id}`, { method: "DELETE" }),
  settings: () => call<SettingsInfo>("/api/settings"),
  saveSettings: (id: IntegrationId, values: Record<string, string>) =>
    call<SettingsInfo>(`/api/settings/${id}`, { method: "PUT", body: JSON.stringify({ values }) }),
  removeSettings: (id: IntegrationId) => call<SettingsInfo>(`/api/settings/${id}`, { method: "DELETE" }),
  testSettings: (id: IntegrationId) =>
    call<{ ok: boolean; message: string; settings: SettingsInfo }>(`/api/settings/${id}/test`, { method: "POST" }),
  setup: () => call<SetupChecklist>("/api/setup"),
  live: () => call<LiveInfo>("/api/live"),
  arm: () => call<LiveInfo>("/api/live/arm", { method: "POST" }),
  disarm: () => call<LiveInfo>("/api/live/disarm", { method: "POST" }),
  setLaunchAt: (launchAt: string) => call<LiveInfo>("/api/live/launch", { method: "PUT", body: JSON.stringify({ launchAt }) }),
  setLiveCreator: (id: number, on: boolean) => call<LiveInfo>(`/api/live/creators/${id}`, { method: "PUT", body: JSON.stringify({ on }) }),
  subscribePush: (subscription: PushSubscriptionJSON) => call<LiveInfo>("/api/live/push", { method: "POST", body: JSON.stringify(subscription) }),
  unsubscribePush: (endpoint: string) => call<LiveInfo>("/api/live/push", { method: "DELETE", body: JSON.stringify({ endpoint }) }),
  setAutoIngest: (id: number, on: boolean) =>
    call<WatchedCreator>(`/api/watchlist/${id}/auto-ingest`, { method: "PUT", body: JSON.stringify({ on }) }),
};
