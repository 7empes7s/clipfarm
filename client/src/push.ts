import { api } from "./api";

export type PushState = "on" | "off" | "blocked" | "unavailable";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** The installed app's service worker; null in a plain dev tab, where there is none. */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unavailable";
  if (Notification.permission === "denied") return "blocked";
  const reg = await registration();
  if (!reg) return "unavailable";
  return (await reg.pushManager.getSubscription()) ? "on" : "off";
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64Url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Asks the browser for permission, subscribes this device and tells the server. */
export async function turnOnPush(publicKey: string): Promise<PushState> {
  const reg = supported() ? await registration() : null;
  if (!reg) return "unavailable";
  if ((await Notification.requestPermission()) !== "granted") return Notification.permission === "denied" ? "blocked" : "off";
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.subscribePush(sub.toJSON());
  return "on";
}

export async function turnOffPush(): Promise<PushState> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (sub) {
    await api.unsubscribePush(sub.endpoint);
    await sub.unsubscribe();
  }
  return "off";
}
