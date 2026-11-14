import type { BrandTemplate, BrandTemplateInput } from "../../shared/studio.js";
import { CLIP_LAYOUTS, type ClipLayout, DEFAULT_EFFECTS } from "../../shared/types.js";
import { parseCaptionStyle, parseEffects } from "../clips/studio.js";
import type { Db } from "../db/index.js";
import { NotFoundError, ValidationError } from "../errors.js";

interface Row {
  id: number;
  name: string;
  data: string;
}

const toTemplate = (r: Row): BrandTemplate => ({ ...(JSON.parse(r.data) as BrandTemplateInput), id: r.id, name: r.name });

/** Checks a brand template from Settings; throws a plain ValidationError. */
export function parseTemplate(body: unknown): BrandTemplateInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) throw new ValidationError("Give the template a name.");
  if (name.length > 60) throw new ValidationError("The name is too long (60 characters at most).");
  const layout = b.layout === null || b.layout === undefined ? null : (b.layout as ClipLayout);
  if (layout !== null && !CLIP_LAYOUTS.includes(layout)) throw new ValidationError("Pick a layout.");
  const str = (v: unknown, label: string, max: number) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s.length > max) throw new ValidationError(`The ${label} is too long (${max} characters at most).`);
    return s;
  };
  const list = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  const hashtags = [...new Set(list(b.hashtags).map((t) => (t.startsWith("#") ? t : `#${t}`).replace(/\s+/g, "")))];
  if (hashtags.length > 10) throw new ValidationError("Use 10 hashtags at most.");
  return {
    name,
    accountIds: [...new Set(list(b.accountIds))],
    layout,
    captionStyle: parseCaptionStyle(b.captionStyle),
    watermark: str(b.watermark, "watermark", 40),
    outro: str(b.outro, "outro text", 60),
    effects: parseEffects(b.effects, DEFAULT_EFFECTS),
    hashtags,
  };
}

/** Brand templates: one look per channel, applied by the account a clip is going to. */
export class TemplatesRepo {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  list(): BrandTemplate[] {
    return (this.db.prepare("SELECT * FROM brand_templates ORDER BY name, id").all() as Row[]).map(toTemplate);
  }

  get(id: number): BrandTemplate {
    const r = this.db.prepare("SELECT * FROM brand_templates WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new NotFoundError("That template was not found.");
    return toTemplate(r);
  }

  /** An account takes one template, so which look applies is never in doubt. */
  private checkAccounts(t: BrandTemplateInput, id: number | null): void {
    for (const other of this.list()) {
      if (other.id === id) continue;
      const shared = t.accountIds.find((a) => other.accountIds.includes(a));
      if (shared) throw new ValidationError(`That account already uses the template "${other.name}". Take it off there first.`);
    }
  }

  create(t: BrandTemplateInput): BrandTemplate {
    this.checkAccounts(t, null);
    const { name, ...data } = t;
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO brand_templates (name, data, created_at) VALUES (?, ?, ?)")
      .run(name, JSON.stringify(data), this.now().toISOString());
    return this.get(Number(lastInsertRowid));
  }

  update(id: number, t: BrandTemplateInput): BrandTemplate {
    this.get(id);
    this.checkAccounts(t, id);
    const { name, ...data } = t;
    this.db.prepare("UPDATE brand_templates SET name = ?, data = ? WHERE id = ?").run(name, JSON.stringify(data), id);
    return this.get(id);
  }

  remove(id: number): void {
    this.get(id);
    this.db.prepare("DELETE FROM brand_templates WHERE id = ?").run(id);
  }
}
