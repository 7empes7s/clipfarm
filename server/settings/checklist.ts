import type { IntegrationId, IntegrationStatus, IsolationGroup, SetupChecklist, SetupItem } from "../../shared/types.js";
import { BURNERS_GROUP_ID } from "../../shared/types.js";

export interface ChecklistInput {
  integrations: IntegrationStatus[];
  /** Accounts linked in the posting service; null when there is none or it could not be asked. */
  postingAccounts: number | null;
  postingLabel: string;
  activePermissions: number;
  clips: number;
  posted: number;
  /** The isolation groups (Settings, Accounts); left out where the server has none. */
  groups?: IsolationGroup[];
}

/** Burners kept apart: what to buy, what to paste and where, until the burner group can post. */
function isolationItem(groups: IsolationGroup[]): SetupItem | null {
  const burners = groups.find((g) => g.id === BURNERS_GROUP_ID);
  if (!burners) return null;
  const app = burners.apps.some((a) => a.set);
  const uris = burners.apps.map((a) => a.redirectUri).join(", ");
  const done = burners.blocked === null && app;
  let line: string;
  if (done) line = `Burners leave from their own address (${burners.proxy.check?.exitIp ?? "tested"}) with their own apps.`;
  else if (!burners.proxy.set) {
    line = `Buy one residential or ISP proxy with a fixed address (any provider) and paste it under Burners, then tap Test. Each group also needs its own developer apps; the redirect addresses to paste in them: ${uris}.`;
  } else if (burners.blocked) line = `Burners: ${burners.blocked}`;
  else line = `The burners' proxy works. Now paste the keys of the burners' own YouTube, TikTok or Instagram app and tap Connect channel. Redirect addresses: ${uris}.`;
  return { id: "isolation", label: "Burner accounts kept apart", done, line, href: "#settings/accounts", action: "Open Accounts" };
}

/** What still stands between a fresh install and the first posted clip, in the order to do it. */
export function buildChecklist(input: ChecklistInput): SetupChecklist {
  const byId = new Map(input.integrations.map((i) => [i.id, i]));
  const ready = (id: IntegrationId) => byId.get(id)?.configured === true && byId.get(id)?.test?.ok === true;
  // Posting needs one of the two; the others are each needed. OpenAI is not: the local engine
  // transcribes and picks, and cloud AI is only an optional speed-up.
  const posting: IntegrationId[] = ready("postiz") || ready("upload-post") ? [] : [byId.get("upload-post")?.configured ? "upload-post" : "postiz"];
  const needed: IntegrationId[] = ["twitch", "youtube", ...posting];
  const open = needed
    .filter((id) => !ready(id))
    .map((id) => `${byId.get(id)?.label ?? id} (${byId.get(id)?.configured ? "not tested" : "not set"})`);

  const isolation = input.groups ? isolationItem(input.groups) : null;
  const items: SetupItem[] = [
    {
      id: "keys",
      label: "Keys set and tested",
      done: open.length === 0,
      line: open.length === 0 ? "Every key is saved and its test passed." : `Paste each key, then tap Test. Still open: ${open.join(", ")}.`,
      href: "#settings",
      action: "Open Settings",
    },
    {
      id: "accounts",
      label: "A posting account linked",
      done: (input.postingAccounts ?? 0) > 0,
      line:
        (input.postingAccounts ?? 0) > 0
          ? `${input.postingAccounts} account${input.postingAccounts === 1 ? "" : "s"} linked in ${input.postingLabel}.`
          : input.postingAccounts === null
            ? "Link TikTok, YouTube or Instagram in Postiz, then paste its key in Settings."
            : `No account is linked in ${input.postingLabel} yet. Link one there, then tap Sync accounts.`,
      href: input.postingAccounts === null ? "#settings/postiz" : "#dashboard/accounts",
      action: input.postingAccounts === null ? "How to link one" : "Open accounts",
    },
    ...(isolation ? [isolation] : []),
    {
      id: "permission",
      label: "A creator who said yes",
      done: input.activePermissions > 0,
      line:
        input.activePermissions > 0
          ? "At least one campaign has a current permission."
          : "Join a creator's clipping program, then add it as a campaign. Nothing is clipped without one.",
      href: "#sources",
      action: "Add a campaign",
    },
    {
      id: "clip",
      label: "First clip made",
      done: input.clips > 0,
      line: input.clips > 0 ? "Clips are in the gallery." : "Paste a stream link into a campaign. Clips show up in the Inbox.",
      href: "#sources",
      action: "Add a stream link",
    },
    {
      id: "post",
      label: "First clip posted",
      done: input.posted > 0,
      line: input.posted > 0 ? "A clip has gone out." : "Approve a clip in the Inbox, then tap Post on it.",
      href: input.clips > 0 ? "#approved" : "#inbox",
      action: "Go to clips",
    },
  ];
  return { items, done: items.every((i) => i.done) };
}
