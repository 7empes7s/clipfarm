import type { Db } from "../db/index.js";
import type { Brand, Workspace, WorkspaceStats, WorkspaceSummary } from "../../shared/creator.js";
import { DEFAULT_BRAND, MY_WORKSPACE_ID } from "../../shared/creator.js";
import { NotFoundError, ValidationError } from "../errors.js";

interface Row {
  id: number;
  name: string;
  brand: string;
  created_at: string;
}

function toWorkspace(r: Row): Workspace {
  return { id: r.id, name: r.name, brand: { ...DEFAULT_BRAND, ...(JSON.parse(r.brand) as Partial<Brand>) }, createdAt: r.created_at };
}

/** Checks a workspace name. */
export function parseWorkspaceName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new ValidationError("Give the workspace a name, like the client's.");
  if (name.length > 60) throw new ValidationError("Keep the name under 60 characters.");
  return name;
}

/** Checks a brand template and returns it clean. */
export function parseBrand(body: unknown): Brand {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number, label: string) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s.length > max) throw new ValidationError(`Keep the ${label} under ${max} characters.`);
    return s;
  };
  const color = typeof b.color === "string" && b.color ? b.color.trim().toLowerCase() : DEFAULT_BRAND.color;
  if (!/^#[0-9a-f]{6}$/.test(color)) throw new ValidationError("Pick a colour like #ffd84d.");
  return { handle: text(b.handle, 40, "handle"), color, callToAction: text(b.callToAction, 140, "closing line") };
}

/**
 * Workspaces: "Me" (id 1, always there) and one per client. Each has its own sources (and so its
 * clips), posting accounts, watched channels and brand. Billing is not part of it yet.
 */
export class WorkspacesRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  list(): Workspace[] {
    return (this.db.prepare("SELECT * FROM workspaces ORDER BY id").all() as Row[]).map(toWorkspace);
  }

  get(id: number): Workspace {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("That workspace was not found.");
    return toWorkspace(row);
  }

  /** The workspace a request names, or "Me" when it names none or one that is gone. */
  resolve(raw: unknown): number {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return MY_WORKSPACE_ID;
    return this.db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(id) ? id : MY_WORKSPACE_ID;
  }

  create(name: string): Workspace {
    if (this.db.prepare("SELECT 1 FROM workspaces WHERE name = ? COLLATE NOCASE").get(name)) {
      throw new ValidationError(`There is already a workspace called ${name}.`);
    }
    const { lastInsertRowid } = this.db.prepare("INSERT INTO workspaces (name, created_at) VALUES (?, ?)").run(name, this.now().toISOString());
    return this.get(Number(lastInsertRowid));
  }

  update(id: number, name: string, brand: Brand): Workspace {
    this.get(id);
    if (this.db.prepare("SELECT 1 FROM workspaces WHERE name = ? COLLATE NOCASE AND id != ?").get(name, id)) {
      throw new ValidationError(`There is already a workspace called ${name}.`);
    }
    this.db.prepare("UPDATE workspaces SET name = ?, brand = ? WHERE id = ?").run(name, JSON.stringify(brand), id);
    return this.get(id);
  }

  /** Moves a posting account to a workspace: it then posts only that workspace's clips. */
  assignAccount(accountId: string, workspaceId: number): void {
    this.get(workspaceId);
    const { changes } = this.db.prepare("UPDATE posting_accounts SET workspace_id = ? WHERE account_id = ?").run(workspaceId, accountId);
    if (changes === 0) throw new NotFoundError("That account was not found.");
  }

  stats(id: number): WorkspaceStats {
    const one = (sql: string) => (this.db.prepare(sql).get({ id }) as { n: number | null }).n ?? 0;
    const ofWs = "(SELECT id FROM sources WHERE workspace_id = @id)";
    return {
      sources: one("SELECT COUNT(*) AS n FROM sources WHERE workspace_id = @id"),
      videos: one(`SELECT COUNT(*) AS n FROM vods WHERE source_id IN ${ofWs}`),
      clipsWaiting: one(`SELECT COUNT(*) AS n FROM clips WHERE status = 'pending' AND source_id IN ${ofWs}`),
      clipsApproved: one(`SELECT COUNT(*) AS n FROM clips WHERE status = 'approved' AND source_id IN ${ofWs}`),
      posts: one(`SELECT COUNT(*) AS n FROM posts WHERE clip_id IN (SELECT id FROM clips WHERE source_id IN ${ofWs})`),
      views: one(`SELECT SUM(views) AS n FROM posts WHERE clip_id IN (SELECT id FROM clips WHERE source_id IN ${ofWs})`),
      accounts: one("SELECT COUNT(*) AS n FROM posting_accounts WHERE listed = 1 AND workspace_id = @id"),
    };
  }

  summaries(): WorkspaceSummary[] {
    return this.list().map((w) => ({ ...w, stats: this.stats(w.id) }));
  }
}
