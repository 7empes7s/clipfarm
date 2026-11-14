import type { Clip, Platform, RejectReason } from "../../../shared/types";
import type { Brand } from "../../../shared/creator";
import type { Invoice, PortalDashboard, PortalMe } from "../../../shared/service";

/** An answer that was not OK, with the server's plain message. 402: a plan limit ("Upgrade"). */
export class PortalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/portal${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new PortalError(res.status, data.error ?? `Something went wrong (${res.status}).`);
  return data as T;
}

export interface PortalSource {
  id: number;
  name: string;
  channelUrls: string[];
}
export interface PortalVideo {
  id: number;
  sourceId: number;
  title: string | null;
  url: string;
  status: string;
  durationSec: number | null;
  createdAt: string;
}
export interface PortalAccount {
  id: string;
  platform: Platform;
  name: string;
  handle: string | null;
  disabled: boolean;
}
export interface PortalCalendarItem {
  id: number;
  clipId: number;
  title: string;
  platform: Platform;
  account: string;
  at: string;
  status: string;
  url: string | null;
  views: number | null;
}

export const portal = {
  /** null: not signed in. */
  me: () => call<PortalMe | null>("GET", "/me"),
  emailLink: (email: string) => call<{ sent: boolean; demoLink?: string }>("POST", "/auth/email", { email }),
  signOut: () => call<{ ok: boolean }>("POST", "/auth/signout", {}),
  settings: (autoApprove: boolean) => call<PortalMe>("PUT", "/settings", { autoApprove }),
  brand: (brand: Brand) => call<PortalMe>("PUT", "/brand", brand),
  checkout: (planId: string) => call<{ url: string }>("POST", "/checkout", { planId }),
  billing: () => call<{ url: string }>("POST", "/billing", {}),
  invoices: () => call<Invoice[]>("GET", "/invoices"),
  sources: () => call<{ sources: PortalSource[]; videos: PortalVideo[] }>("GET", "/sources"),
  addSource: (input: { name: string; link: string; ownerName: string; attested: boolean; sourceId?: number | null }) =>
    call<{ sources: PortalSource[]; videos: PortalVideo[] }>("POST", "/sources", input),
  removeSource: (id: number) => call<{ sources: PortalSource[]; videos: PortalVideo[] }>("DELETE", `/sources/${id}`),
  accounts: () => call<{ accounts: PortalAccount[]; connectable: Platform[] }>("GET", "/accounts"),
  connect: (platform: Platform) => call<{ url: string }>("POST", "/accounts/connect", { platform }),
  clips: () => call<Clip[]>("GET", "/clips"),
  approve: (id: number) => call<Clip>("POST", `/clips/${id}/approve`, {}),
  reject: (id: number, reason: RejectReason | null) => call<Clip>("POST", `/clips/${id}/reject`, { reason }),
  calendar: (from: Date, to: Date) =>
    call<{ timeZone: string; items: PortalCalendarItem[] }>("GET", `/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
  dashboard: () => call<PortalDashboard>("GET", "/dashboard"),
};
