import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  type BrandTemplate,
  type BrandTemplateInput,
  CAPTION_FONTS,
  CAPTION_POSITION_LABELS,
  CAPTION_POSITIONS,
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  type CaptionStyle,
  DEFAULT_CAPTION_STYLE,
} from "../../shared/studio";
import type { ClipLayout } from "../../shared/types";
import { CLIP_EFFECT_LABELS, CLIP_EFFECTS, CLIP_LAYOUT_LABELS, CLIP_LAYOUTS, DEFAULT_EFFECTS, PLATFORM_LABELS, type Platform } from "../../shared/types";
import { api } from "./api";
import { Sheet } from "./Sheet";

const BLANK: BrandTemplateInput = {
  name: "",
  accountIds: [],
  layout: null,
  captionStyle: DEFAULT_CAPTION_STYLE,
  watermark: "",
  outro: "",
  effects: DEFAULT_EFFECTS,
  hashtags: [],
};

type Account = { accountId: string; name: string; platform: Platform };

/** Settings › Brand templates: one look per channel, applied by itself to clips going to its accounts. */
export function TemplatesSettings({ focus }: { focus: boolean }) {
  const [templates, setTemplates] = useState<BrandTemplate[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [editing, setEditing] = useState<BrandTemplate | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .templates()
      .then(setTemplates)
      .catch((err: Error) => setError(err.message));
    api
      .accounts()
      .then((info) => setAccounts(info.cards))
      .catch(() => setAccounts([]));
  }, []);
  useEffect(() => {
    if (focus && templates) document.getElementById("settings-templates")?.scrollIntoView({ block: "start" });
  }, [focus, templates]);
  const close = useCallback(() => setEditing(null), []);

  const name = (id: string) => accounts.find((a) => a.accountId === id)?.name ?? id;
  return (
    <div className="card" id="settings-templates" data-testid="settings-templates">
      <h3>Brand templates</h3>
      <p className="hint">Fonts, caption colours, watermark, outro, layout and hashtags per channel. The Studio applies them by the account a clip is going to.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {templates && templates.length > 0 && (
        <ul className="template-list">
          {templates.map((t) => (
            <li key={t.id}>
              <span className="template-swatch" style={{ background: t.captionStyle.hookColor, color: t.captionStyle.color, fontFamily: t.captionStyle.font }} aria-hidden="true">
                Aa
              </span>
              <span className="template-name">
                <strong>{t.name}</strong>
                <span className="hint">{t.accountIds.length ? t.accountIds.map(name).join(", ") : "No accounts yet"}</span>
              </span>
              <button type="button" onClick={() => setEditing(t)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => setEditing("new")}>
        Add a template
      </button>
      {editing && (
        <TemplateSheet
          template={editing === "new" ? null : editing}
          accounts={accounts}
          onClose={close}
          onSaved={(list) => {
            setTemplates(list);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TemplateSheet({
  template,
  accounts,
  onClose,
  onSaved,
}: {
  template: BrandTemplate | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: (list: BrandTemplate[]) => void;
}) {
  const [t, setT] = useState<BrandTemplateInput>(template ?? BLANK);
  const [tags, setTags] = useState((template?.hashtags ?? []).join(" "));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const style = (s: Partial<CaptionStyle>) => setT({ ...t, captionStyle: { ...t.captionStyle, ...s } });

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { ...t, hashtags: tags.split(/[\s,]+/).filter(Boolean) };
      if (template) await api.saveTemplate(template.id, body);
      else await api.addTemplate(body);
      onSaved(await api.templates());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  async function remove() {
    if (!template) return;
    setSaving(true);
    try {
      await api.removeTemplate(template.id);
      onSaved(await api.templates());
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <Sheet id="template-sheet-title" title={template ? `Edit “${template.name}”` : "Add a brand template"} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <label>
          Name
          <input value={t.name} maxLength={60} required placeholder="GTA VI moments" onChange={(e) => setT({ ...t, name: e.target.value })} />
        </label>
        <fieldset>
          <legend>For these accounts</legend>
          {accounts.length === 0 ? (
            <p className="hint">No posting accounts are connected yet. Connect them in Settings › Accounts.</p>
          ) : (
            <div className="chips">
              {accounts.map((a) => (
                <label key={a.accountId} className="chip">
                  <input
                    type="checkbox"
                    checked={t.accountIds.includes(a.accountId)}
                    onChange={(e) =>
                      setT({ ...t, accountIds: e.target.checked ? [...t.accountIds, a.accountId] : t.accountIds.filter((x) => x !== a.accountId) })
                    }
                  />
                  {a.name} ({PLATFORM_LABELS[a.platform]})
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <label>
          Layout
          <select value={t.layout ?? ""} onChange={(e) => setT({ ...t, layout: (e.target.value || null) as ClipLayout | null })}>
            <option value="">Keep each clip's layout</option>
            {CLIP_LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {CLIP_LAYOUT_LABELS[l]}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <label>
            Caption font
            <select value={t.captionStyle.font} onChange={(e) => style({ font: e.target.value as CaptionStyle["font"] })}>
              {CAPTION_FONTS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            Size {t.captionStyle.size}
            <input type="range" min={CAPTION_SIZE_MIN} max={CAPTION_SIZE_MAX} value={t.captionStyle.size} onChange={(e) => style({ size: Number(e.target.value) })} />
          </label>
        </div>
        <div className="row studio-colours">
          <label>
            Text
            <input type="color" value={t.captionStyle.color} onChange={(e) => style({ color: e.target.value.toUpperCase() })} />
          </label>
          <label>
            Word being said
            <input type="color" value={t.captionStyle.highlight} onChange={(e) => style({ highlight: e.target.value.toUpperCase() })} />
          </label>
          <label>
            Hook box
            <input type="color" value={t.captionStyle.hookColor} onChange={(e) => style({ hookColor: e.target.value.toUpperCase() })} />
          </label>
        </div>
        <div className="chips">
          {CAPTION_POSITIONS.map((p) => (
            <label key={p} className="chip">
              <input type="radio" name="tpl-pos" checked={t.captionStyle.position === p} onChange={() => style({ position: p })} />
              {CAPTION_POSITION_LABELS[p]}
            </label>
          ))}
          <label className="chip">
            <input type="checkbox" checked={t.captionStyle.wordByWord} onChange={(e) => style({ wordByWord: e.target.checked })} />
            Highlight word by word
          </label>
        </div>
        <div className="row">
          <label>
            Watermark
            <input value={t.watermark} maxLength={40} placeholder="@yourchannel" onChange={(e) => setT({ ...t, watermark: e.target.value })} />
          </label>
          <label>
            Outro (last 1.5 s)
            <input value={t.outro} maxLength={60} placeholder="Follow for more" onChange={(e) => setT({ ...t, outro: e.target.value })} />
          </label>
        </div>
        <label>
          Hashtags
          <input value={tags} placeholder="#gta6 #gtavi" onChange={(e) => setTags(e.target.value)} />
          <span className="hint">Added to the caption when a clip posts to these accounts, after any the campaign asks for.</span>
        </label>
        <fieldset>
          <legend>Finishing touches</legend>
          <div className="chips">
            {CLIP_EFFECTS.map((fx) => (
              <label key={fx} className="chip">
                <input type="checkbox" checked={t.effects[fx]} onChange={(e) => setT({ ...t, effects: { ...t.effects, [fx]: e.target.checked } })} />
                {CLIP_EFFECT_LABELS[fx]}
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save template"}
        </button>
        {template && (
          <button type="button" className="danger" disabled={saving} onClick={() => void remove()}>
            Delete template
          </button>
        )}
      </form>
    </Sheet>
  );
}
