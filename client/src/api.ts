import type { Snooze, SubmitHours, SubmitWindowInfo } from "../../shared/submitWindow";
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
  LiveVersion,
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
  IsolationInfo,
  DirectPlatform,
  ProxyCheck,
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
import type { HookLabInfo, HookLabSettings, TrendReport } from "../../shared/trends";

import type { CampaignComparison, CampaignReport, GrowthCampaign, GrowthCampaignInput, GrowthInfo } from "../../shared/growth";
import type { ScoutInfo, ScoutStatus } from "../../shared/scout";
import type { ProofInfo } from "../../shared/proof";
import type { BrandTemplate, BrandTemplateInput } from "../../shared/studio";
import type { ClipVersion, StudioEditInput, StudioInfo } from "../../shared/types";
import type { AutopilotInfo, AutopilotRule, AutopilotStep, CalendarInfo, ClipVersions } from "../../shared/publishing";
import type { Brand, CreatorInfo, Upload, Workspace, WorkspaceSummary } from "../../shared/creator";

const WS_KEY = "clipfarm.workspace";

function storedWorkspace(): number {
  try {
    return Number(localStorage.getItem(WS_KEY)) || 1;
  } catch {
    return 1;
  }
}

/** The workspace (me, or a client) every call is about; the header's switcher changes it. */
let workspace = storedWorkspace();

export function currentWorkspace(): number {
  return workspace;
}

export function setWorkspace(id: number): void {
  workspace = id;
  try {
    localStorage.setItem(WS_KEY, String(id));
  } catch {
    /* private mode: the choice lasts until the page is closed */
  }
}
import type { BusinessBoard, HealthBoard, RangeId } from "../../shared/business";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "X-Workspace": String(workspace), ...(init?.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}.`);
  return body;
}

export const api = {
  workspaces: () => call<WorkspaceSummary[]>("/api/workspaces"),
  addWorkspace: (name: string) => call<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  saveWorkspace: (id: number, name: string, brand: Brand) =>
    call<Workspace>(`/api/workspaces/${id}`, { method: "PUT", body: JSON.stringify({ name, brand }) }),
  accountWorkspace: (accountId: string, workspaceId: number) =>
    call<unknown>(`/api/accounts/${encodeURIComponent(accountId)}/workspace`, { method: "PUT", body: JSON.stringify({ workspaceId }) }),
  creator: () => call<CreatorInfo>("/api/creator"),
  addCreatorVideo: (input: { sourceId: number | null; name: string; ownerName: string; attested: boolean; link: string | null; uploadId: number | null }) =>
    call<{ source: Source; vods: Vod[]; watching: WatchedCreator | null; feedTitle: string | null }>("/api/creator", { method: "POST", body: JSON.stringify(input) }),
  startUpload: (fileName: string, sizeBytes: number) => call<Upload>("/api/uploads", { method: "POST", body: JSON.stringify({ fileName, sizeBytes }) }),
  upload: (id: number) => call<Upload>(`/api/uploads/${id}`),
  /** Sends one piece of a file; a 409 means "carry on from where the server says". */
  uploadPiece: async (id: number, offset: number, piece: Blob): Promise<Response> =>
    fetch(`/api/uploads/${id}?offset=${offset}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "X-Workspace": String(workspace) },
      body: piece,
    }),
  attest: (permissionId: number, ownerName: string) =>
    call<Source>(`/api/permissions/${permissionId}/attest`, { method: "POST", body: JSON.stringify({ ownerName }) }),
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
  studio: (id: number) => call<StudioInfo>(`/api/clips/${id}/studio`),
  studioExport: (id: number, edit: StudioEditInput) =>
    call<{ clip: Clip; job: Job }>(`/api/clips/${id}/studio`, { method: "POST", body: JSON.stringify(edit) }),
  splitClip: (id: number, edit: StudioEditInput, atSec: number) =>
    call<{ clips: Clip[] }>(`/api/clips/${id}/split`, { method: "POST", body: JSON.stringify({ ...edit, atSec }) }),
  restoreVersion: (id: number, versionId: number) => call<Clip>(`/api/clips/${id}/renders/${versionId}/restore`, { method: "POST" }),
  revertClip: (id: number) => call<Clip>(`/api/clips/${id}/revert`, { method: "POST" }),
  setCaptionFix: (id: number, n: number, applied: boolean) =>
    call<{ clip: Clip }>(`/api/clips/${id}/caption-fixes/${n}`, { method: "POST", body: JSON.stringify({ applied }) }),
  clipVersions: (id: number) => call<ClipVersion[]>(`/api/clips/${id}/renders`),
  hookIdeas: (id: number, ai: boolean) =>
    call<{ hook: string; title: string }[]>(`/api/clips/${id}/hook-ideas`, { method: "POST", body: JSON.stringify({ ai }) }),
  templates: () => call<BrandTemplate[]>("/api/templates"),
  addTemplate: (t: BrandTemplateInput) => call<BrandTemplate>("/api/templates", { method: "POST", body: JSON.stringify(t) }),
  saveTemplate: (id: number, t: BrandTemplateInput) => call<BrandTemplate>(`/api/templates/${id}`, { method: "PUT", body: JSON.stringify(t) }),
  removeTemplate: (id: number) => call<unknown>(`/api/templates/${id}`, { method: "DELETE" }),
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
  submitWindow: () => call<SubmitWindowInfo>("/api/posting/submit"),
  saveSubmitHours: (hours: SubmitHours) => call<SubmitWindowInfo>("/api/posting/submit-hours", { method: "PUT", body: JSON.stringify(hours) }),
  snooze: (choice: Snooze | "off") => call<SubmitWindowInfo>("/api/posting/snooze", { method: "POST", body: JSON.stringify({ for: choice }) }),
  posts: () => call<Post[]>("/api/posts"),
  refreshPosts: () => call<{ updated: number; error: string | null }>("/api/posts/refresh", { method: "POST" }),
  setViews: (id: number, views: number) => call<Post>(`/api/posts/${id}/views`, { method: "POST", body: JSON.stringify({ views }) }),
  markWhop: (id: number, step: WhopStep, on: boolean) =>
    call<Post>(`/api/posts/${id}/whop`, { method: "POST", body: JSON.stringify({ step, on }) }),
  rejectWhop: (id: number, reason: string | null) => call<Post>(`/api/posts/${id}/whop-reject`, { method: "POST", body: JSON.stringify({ reason }) }),
  calendar: (from: Date, to: Date) => call<CalendarInfo>(`/api/calendar?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`),
  saveCalendarSettings: (tiktokAudited: boolean) =>
    call<{ tiktokAudited: boolean }>("/api/calendar/settings", { method: "PUT", body: JSON.stringify({ tiktokAudited }) }),
  reschedule: (id: number, at: Date) =>
    call<{ post: Post; reasons: string[] }>(`/api/posts/${id}/reschedule`, { method: "POST", body: JSON.stringify({ at: at.toISOString() }) }),
  retryPost: (id: number) => call<PostOutcome>(`/api/posts/${id}/retry`, { method: "POST" }),
  versions: (clipId: number) => call<ClipVersions>(`/api/clips/${clipId}/versions`),
  saveVersion: (clipId: number, platform: Platform, v: { title: string; caption: string; hashtags: string; coverId: number | null }) =>
    call<ClipVersions>(`/api/clips/${clipId}/versions/${platform}`, { method: "PUT", body: JSON.stringify(v) }),
  resetVersion: (clipId: number, platform: Platform) => call<ClipVersions>(`/api/clips/${clipId}/versions/${platform}`, { method: "DELETE" }),
  autopilot: () => call<AutopilotInfo>("/api/autopilot"),
  saveRule: (id: number | null, rule: Omit<AutopilotRule, "id">) =>
    call<AutopilotRule>(id === null ? "/api/autopilot/rules" : `/api/autopilot/rules/${id}`, { method: id === null ? "POST" : "PUT", body: JSON.stringify(rule) }),
  deleteRule: (id: number) => call<unknown>(`/api/autopilot/rules/${id}`, { method: "DELETE" }),
  dryRunRule: (id: number) => call<AutopilotStep[]>(`/api/autopilot/rules/${id}/dry-run`, { method: "POST" }),
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
  liveVersion: () => call<LiveVersion | null>("/api/live-version"),
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
  groups: () => call<IsolationInfo>("/api/groups"),
  addGroup: (name: string, kind: string) => call<IsolationInfo>("/api/groups", { method: "POST", body: JSON.stringify({ name, kind }) }),
  removeGroup: (id: number) => call<IsolationInfo>(`/api/groups/${id}`, { method: "DELETE" }),
  saveGroupApp: (id: number, platform: DirectPlatform, keys: { id: string; secret: string }) =>
    call<IsolationInfo>(`/api/groups/${id}/apps/${platform}`, { method: "PUT", body: JSON.stringify(keys) }),
  removeGroupApp: (id: number, platform: DirectPlatform) => call<IsolationInfo>(`/api/groups/${id}/apps/${platform}`, { method: "DELETE" }),
  saveGroupProxy: (id: number, url: string) => call<IsolationInfo>(`/api/groups/${id}/proxy`, { method: "PUT", body: JSON.stringify({ url }) }),
  removeGroupProxy: (id: number) => call<IsolationInfo>(`/api/groups/${id}/proxy`, { method: "DELETE" }),
  testGroupProxy: (id: number) => call<IsolationInfo & { check: ProxyCheck }>(`/api/groups/${id}/proxy/test`, { method: "POST" }),
  connectChannel: (id: number, platform: DirectPlatform) => call<{ url: string }>(`/api/groups/${id}/connect/${platform}`, { method: "POST" }),
  moveAccount: (accountId: string, groupId: number) =>
    call<IsolationInfo>(`/api/accounts/${encodeURIComponent(accountId)}/group`, { method: "PUT", body: JSON.stringify({ groupId }) }),
  trends: () => call<TrendReport>("/api/trends"),
  refreshTrends: () => call<TrendReport>("/api/trends/refresh", { method: "POST" }),
  saveTrendWeight: (weight: number) => call<TrendReport>("/api/trends/weight", { method: "PUT", body: JSON.stringify({ weight }) }),
  hookLab: () => call<HookLabInfo>("/api/hooklab"),
  saveHookLab: (change: Partial<HookLabSettings>) => call<HookLabInfo>("/api/hooklab/settings", { method: "PUT", body: JSON.stringify(change) }),
  runHookLab: () => call<HookLabInfo>("/api/hooklab/run", { method: "POST" }),
  growth: () => call<GrowthInfo>("/api/growth"),
  business: (range: RangeId) => call<BusinessBoard>(`/api/business?range=${range}`),
  businessHealth: () => call<HealthBoard>("/api/business/health"),
  /** A campaign's CSV export, sent as it is. */
  importPayouts: async (csv: string) => {
    const res = await fetch("/api/business/payouts", { method: "POST", headers: { "Content-Type": "text/csv" }, body: csv });
    const body = (await res.json().catch(() => ({}))) as { imported: number; matched: number; skipped: number; unmatched: string[]; error?: string };
    if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}.`);
    return body;
  },
  addCampaign: (input: GrowthCampaignInput) => call<GrowthCampaign>("/api/growth/campaigns", { method: "POST", body: JSON.stringify(input) }),
  campaignAction: (id: number, action: "start" | "pause" | "stop") => call<GrowthCampaign>(`/api/growth/campaigns/${id}/${action}`, { method: "POST" }),
  removeCampaign: (id: number) => call<unknown>(`/api/growth/campaigns/${id}`, { method: "DELETE" }),
  campaignReport: (id: number) => call<CampaignReport>(`/api/growth/campaigns/${id}/report`),
  compareCampaigns: (ids: number[]) => call<CampaignComparison>(`/api/growth/compare?ids=${ids.join(",")}`),
  recommendation: (id: number, action: "apply" | "undo" | "dismiss") =>
    call<GrowthInfo>(`/api/growth/recommendations/${id}/${action}`, { method: "POST" }),
  setDigestZone: (zone: string) => call<GrowthInfo>("/api/growth/digest-zone", { method: "PUT", body: JSON.stringify({ zone }) }),
  scout: () => call<ScoutInfo>("/api/scout"),
  scoutNow: () => call<ScoutInfo>("/api/scout/run", { method: "POST" }),
  scoutMark: (id: number, status: ScoutStatus) =>
    // keepalive: "Join" opens the campaign's page, and the note that it was tapped must still arrive.
    call<ScoutInfo>(`/api/scout/campaigns/${id}`, { method: "PUT", body: JSON.stringify({ status }), keepalive: true }),
  scoutAuto: (on: boolean) => call<ScoutInfo>("/api/scout/auto", { method: "PUT", body: JSON.stringify({ on }) }),
  live: () => call<LiveInfo>("/api/live"),
  proof: () => call<ProofInfo>("/api/proof"),
  runProof: () => call<ProofInfo>("/api/proof/run", { method: "POST" }),
  runDrill: () => call<ProofInfo>("/api/proof/drill", { method: "POST" }),
  arm: () => call<LiveInfo>("/api/live/arm", { method: "POST" }),
  disarm: () => call<LiveInfo>("/api/live/disarm", { method: "POST" }),
  setLaunchAt: (launchAt: string) => call<LiveInfo>("/api/live/launch", { method: "PUT", body: JSON.stringify({ launchAt }) }),
  setLiveCreator: (id: number, on: boolean) => call<LiveInfo>(`/api/live/creators/${id}`, { method: "PUT", body: JSON.stringify({ on }) }),
  subscribePush: (subscription: PushSubscriptionJSON) => call<LiveInfo>("/api/live/push", { method: "POST", body: JSON.stringify(subscription) }),
  unsubscribePush: (endpoint: string) => call<LiveInfo>("/api/live/push", { method: "DELETE", body: JSON.stringify({ endpoint }) }),
  setAutoIngest: (id: number, on: boolean) =>
    call<WatchedCreator>(`/api/watchlist/${id}/auto-ingest`, { method: "PUT", body: JSON.stringify({ on }) }),
};
