import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addCut,
  AI_ELEMENT_LABELS,
  AI_ELEMENTS,
  applyTemplate,
  CAPTION_FONTS,
  CAPTION_POSITION_LABELS,
  CAPTION_POSITIONS,
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  type CaptionStyle,
  type ClipLook,
  editedLength,
  fillerCuts,
  isFiller,
  keptSegments,
  removeCut,
  snapToWord,
  templateForAccount,
  toEditedTime,
  type TimeRange,
  wordRange,
} from "../../shared/studio";
import type { ClipEffects, ClipLayout, ClipVersion, StudioEditInput, StudioInfo, Word } from "../../shared/types";
import { CLIP_EFFECT_LABELS, CLIP_EFFECTS, CLIP_LAYOUT_LABELS, CLIP_LAYOUTS, CLIP_MAX_SEC, CLIP_MIN_SEC } from "../../shared/types";
import { api } from "./api";
import { clock } from "./format";
import { canRedo, canUndo, type History, push, redo, start, undo } from "./history";
import { StudioTimeline } from "./StudioTimeline";

type Panel = "words" | "look" | "why" | "versions";
const PANELS: { id: Panel; label: string }[] = [
  { id: "words", label: "Words" },
  { id: "look", label: "Look" },
  { id: "why", label: "Why this clip" },
  { id: "versions", label: "Versions" },
];

const HOOK_SEC = 1.5;
const OUTRO_SEC = 1.5;

const fmt = (sec: number) => `${clock(sec)}.${Math.floor((sec % 1) * 10)}`;

function editOf(info: StudioInfo): StudioEditInput {
  const c = info.clip;
  return { title: c.title, hook: c.hook, layout: c.layout, startSec: c.startSec, endSec: c.endSec, cuts: c.cuts, effects: c.effects, look: c.look };
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** The Studio: edit one clip by its words and its timeline, set its look, see why it was picked, and keep every export. */
export function Studio({ clipId, onClose }: { clipId: number; onClose: () => void }) {
  const [info, setInfo] = useState<StudioInfo | null>(null);
  const [hist, setHist] = useState<History<StudioEditInput> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("words");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const next = await api.studio(clipId);
    setInfo(next);
    return next;
  }, [clipId]);

  useEffect(() => {
    api
      .studio(clipId)
      .then((next) => {
        setInfo(next);
        setHist(start(editOf(next)));
      })
      .catch((err: Error) => setError(err.message));
  }, [clipId]);

  // While the new version is being made, look again every 2 s; when it is back, play it under Versions.
  const rendering = info?.clip.status === "rendering";
  useEffect(() => {
    if (!rendering) return;
    const t = setInterval(() => {
      load()
        .then((next) => {
          if (next.clip.status !== "rendering") {
            setHist(start(editOf(next)));
            setNote("The new version is ready. It plays under Versions.");
            setPanel("versions");
          }
        })
        .catch((err: Error) => setError(err.message));
    }, 2000);
    return () => clearInterval(t);
  }, [rendering, load]);

  if (error && !info) {
    return (
      <StudioShell title="Studio" onClose={onClose}>
        <p className="error" role="alert">
          {error}
        </p>
      </StudioShell>
    );
  }
  if (!info || !hist) {
    return (
      <StudioShell title="Studio" onClose={onClose}>
        <p className="hint">Opening the clip…</p>
      </StudioShell>
    );
  }
  return (
    <StudioEditor
      info={info}
      hist={hist}
      setHist={setHist}
      panel={panel}
      setPanel={setPanel}
      busy={busy}
      setBusy={setBusy}
      error={error}
      setError={setError}
      note={note}
      setNote={setNote}
      reload={load}
      onClose={onClose}
    />
  );
}

function StudioShell({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="studio" aria-labelledby="studio-title">
      <header className="studio-bar">
        <button type="button" className="close" aria-label="Close the Studio" onClick={onClose}>
          ×
        </button>
        <h2 id="studio-title">{title}</h2>
        <div className="studio-bar-actions">{actions}</div>
      </header>
      {children}
    </section>
  );
}

interface EditorProps {
  info: StudioInfo;
  hist: History<StudioEditInput>;
  setHist: (h: History<StudioEditInput>) => void;
  panel: Panel;
  setPanel: (p: Panel) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  error: string | null;
  setError: (e: string | null) => void;
  note: string | null;
  setNote: (n: string | null) => void;
  reload: () => Promise<StudioInfo>;
  onClose: () => void;
}

function StudioEditor({ info, hist, setHist, panel, setPanel, busy, setBusy, error, setError, note, setNote, reload, onClose }: EditorProps) {
  const { clip, source } = info;
  const edit = hist.present;
  const words = clip.captionWords;
  const total = clip.masterDurationSec;
  const video = useRef<HTMLVideoElement>(null);
  const [playhead, setPlayhead] = useState(edit.startSec);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [account, setAccount] = useState("");
  const locked = clip.status === "rendering" || clip.postCount > 0;

  const segs = useMemo(() => keptSegments(edit.startSec, edit.endSec, edit.cuts), [edit.startSec, edit.endSec, edit.cuts]);
  const length = editedLength(segs);
  const lengthOk = length >= CLIP_MIN_SEC && length <= CLIP_MAX_SEC;
  const change = (next: Partial<StudioEditInput>) => setHist(push(hist, { ...edit, ...next }));
  const setLook = (l: Partial<ClipLook>) => change({ look: { ...edit.look, ...l } });
  const setStyle = (s: Partial<CaptionStyle>) => setLook({ captionStyle: { ...edit.look.captionStyle, ...s } });

  const seek = useCallback((t: number) => {
    setPlayhead(t);
    if (video.current) video.current.currentTime = t;
  }, []);

  // Play only what is kept: jump over cuts, loop at the end.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onTime = () => {
      const t = v.currentTime;
      if (t >= edit.endSec || t < edit.startSec - 0.25) {
        v.currentTime = edit.startSec;
      } else {
        const cut = edit.cuts.find((c) => t >= c.startSec && t < c.endSec);
        if (cut) v.currentTime = cut.endSec;
      }
      setPlayhead(v.currentTime);
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [edit.startSec, edit.endSec, edit.cuts]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const isCut = (w: Word) => edit.cuts.some((c) => w.startSec >= c.startSec - 0.001 && w.endSec <= c.endSec + 0.001);
  const selRange: TimeRange | null = sel ? wordRange(words, sel.a, sel.b) : null;
  const selAllCut = sel !== null && words.slice(Math.min(sel.a, sel.b), Math.max(sel.a, sel.b) + 1).every(isCut);

  const cutSelection = () => {
    if (!selRange) return;
    change({ cuts: selAllCut ? removeCut(edit.cuts, selRange) : addCut(edit.cuts, selRange) });
    setSel(null);
  };

  const setIn = (t: number) => {
    const s = snapToWord(t, words, "start");
    if (s < edit.endSec) change({ startSec: s });
  };
  const setOut = (t: number) => {
    const e = snapToWord(t, words, "end");
    if (e > edit.startSec) change({ endSec: e });
  };

  const fillers = useMemo(() => fillerCuts(words, edit.startSec, edit.endSec).filter((f) => !edit.cuts.some((c) => c.startSec <= f.startSec && c.endSec >= f.endSec)), [words, edit]);

  // Desktop keys: space play/pause, J back, K pause, L play (again: faster), I/O in and out, Delete cuts, Ctrl+Z / Ctrl+Shift+Z.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.altKey) return;
      const v = video.current;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        setHist(e.shiftKey ? redo(hist) : undo(hist));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "y") {
        e.preventDefault();
        setHist(redo(hist));
        return;
      }
      if (e.ctrlKey || e.metaKey) return;
      if (k === " ") {
        e.preventDefault();
        togglePlay();
      } else if (k === "j") seek(Math.max(edit.startSec, playhead - 1));
      else if (k === "k") v?.pause();
      else if (k === "l" && v) {
        v.playbackRate = v.paused ? 1 : Math.min(2, v.playbackRate + 0.5);
        void v.play().catch(() => undefined);
      } else if (k === "i") setIn(playhead);
      else if (k === "o") setOut(playhead);
      else if ((k === "delete" || k === "backspace") && sel) {
        e.preventDefault();
        cutSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pickWord = (i: number, extend: boolean) => {
    if (extend && sel) setSel({ a: sel.a, b: i });
    else if (sel && sel.a === sel.b && sel.a !== i) setSel({ a: sel.a, b: i });
    else setSel({ a: i, b: i });
    seek(words[i]!.startSec);
  };

  async function exportClip() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.studioExport(clip.id, edit);
      await reload();
      setNote("Making the new version. It plays here when it is ready.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function split() {
    setBusy(true);
    setError(null);
    try {
      const { clips } = await api.splitClip(clip.id, edit, playhead);
      const next = await reload();
      setHist(start(editOf(next)));
      setNote(`Split in two. Part 2 is a new clip, “${clips[1]!.title}”, and both are being remade.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const goingTo = (accountId: string) => {
    setAccount(accountId);
    const t = templateForAccount(info.templates, accountId);
    if (t) {
      setHist(push(hist, { ...edit, ...applyTemplate(edit, t, { hasFaceCam: source.faceCam !== null }) }));
      setNote(`Applied the “${t.name}” template.`);
    }
  };
  const pickTemplate = (id: number) => {
    const t = info.templates.find((x) => x.id === id);
    if (t) setHist(push(hist, { ...edit, ...applyTemplate(edit, t, { hasFaceCam: source.faceCam !== null }) }));
  };

  const editedNow = toEditedTime(playhead, segs);
  return (
    <StudioShell
      title={edit.title || "Studio"}
      onClose={onClose}
      actions={
        <>
          <button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo(hist)} onClick={() => setHist(undo(hist))}>
            ↶
          </button>
          <button type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo(hist)} onClick={() => setHist(redo(hist))}>
            ↷
          </button>
          <button type="button" className="primary" disabled={locked || busy || !lengthOk} onClick={() => void exportClip()}>
            {clip.status === "rendering" ? "Making…" : "Export"}
          </button>
        </>
      }
    >
      {(error || note || locked) && (
        <div className="studio-notes">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {note && (
            <p className="hint" role="status">
              {note}
            </p>
          )}
          {clip.postCount > 0 && <p className="hint">This clip is already posted, so it cannot be changed.</p>}
        </div>
      )}
      <div className="studio-grid">
        <div className="studio-stage">
          <Preview clip={info.clip} edit={edit} words={words} playhead={playhead} editedNow={editedNow} length={length} video={video} onCrop={(x) => setLook({ cropX: x })} onPlaying={setPlaying} onLoaded={() => seek(edit.startSec)} />
          <StudioTimeline
            src={clip.masterUrl}
            total={total}
            startSec={edit.startSec}
            endSec={edit.endSec}
            cuts={edit.cuts}
            playhead={playhead}
            words={words}
            onSeek={seek}
            onTrim={(e, t) => (e === "start" ? setIn(t) : setOut(t))}
          />
          <div className="studio-transport">
            <button type="button" className="primary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "Pause" : "Play"}
            </button>
            <button type="button" onClick={() => setIn(playhead)} title="Start here (I)">
              Start here
            </button>
            <button type="button" onClick={() => setOut(playhead)} title="End here (O)">
              End here
            </button>
            <span className={lengthOk ? "studio-len" : "studio-len bad"} data-testid="studio-length">
              {fmt(length)} kept
            </span>
          </div>
          <p className="hint studio-keys">Keys: space play, J back, K pause, L play, I start, O end, Delete cut, Ctrl+Z undo.</p>
        </div>

        <div className="studio-panel">
          <div className="studio-tabs" role="tablist" aria-label="Studio panels">
            {PANELS.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={panel === p.id} onClick={() => setPanel(p.id)}>
                {p.label}
              </button>
            ))}
          </div>

          {panel === "words" && (
            <div className="studio-words" role="tabpanel" aria-label="Words">
              <div className="studio-word-tools">
                <button type="button" disabled={fillers.length === 0} onClick={() => change({ cuts: fillers.reduce(addCut, edit.cuts) })}>
                  Remove fillers and pauses ({fillers.length})
                </button>
                <button type="button" disabled={locked || busy} onClick={() => void split()} title="Splits at the word gap nearest the playhead">
                  Split at playhead
                </button>
              </div>
              {sel && (
                <div className="studio-selection" role="group" aria-label="Selected words">
                  <button type="button" className={selAllCut ? "" : "danger"} onClick={cutSelection}>
                    {selAllCut ? "Restore" : "Cut"}
                  </button>
                  <button type="button" onClick={() => setIn(selRange!.startSec)}>
                    Start here
                  </button>
                  <button type="button" onClick={() => setOut(selRange!.endSec)}>
                    End here
                  </button>
                  <button type="button" className="close" aria-label="Clear the selection" onClick={() => setSel(null)}>
                    ×
                  </button>
                </div>
              )}
              {words.length === 0 ? (
                <p className="hint">This clip has no words to edit by. Use the timeline handles.</p>
              ) : (
                <p className="transcript" data-testid="transcript">
                  {words.map((w, i) => {
                    const outside = w.endSec <= edit.startSec || w.startSec >= edit.endSec;
                    const lo = sel ? Math.min(sel.a, sel.b) : -1;
                    const hi = sel ? Math.max(sel.a, sel.b) : -2;
                    const cls = [
                      "word",
                      outside && "outside",
                      isCut(w) && "cut",
                      isFiller(w.word) && "filler",
                      i >= lo && i <= hi && "selected",
                      playhead >= w.startSec && playhead < w.endSec && "now",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <button key={i} type="button" className={cls} onClick={(e) => pickWord(i, e.shiftKey)}>
                        {w.word}
                      </button>
                    );
                  })}
                </p>
              )}
              <p className="hint">Tap a word, then another, to select the words between. Cut takes them out of the clip; nothing is lost.</p>
            </div>
          )}

          {panel === "look" && (
            <LookPanel info={info} edit={edit} change={change} setLook={setLook} setStyle={setStyle} account={account} goingTo={goingTo} pickTemplate={pickTemplate} />
          )}

          {panel === "why" && (
            <div role="tabpanel" aria-label="Why this clip" className="studio-why" data-testid="why">
              {clip.score !== null && (
                <p className="studio-score">
                  <strong>{Math.round(clip.score)}</strong> picker score
                </p>
              )}
              {clip.reason && <p className="hint">{clip.reason}</p>}
              <ul className="why-list">
                {info.breakdown.map((p) => (
                  <li key={p.key}>
                    <div className="why-head">
                      <span>{p.label}</span>
                      <strong>{p.value === null ? "—" : p.value}</strong>
                    </div>
                    <span className="why-bar" aria-hidden="true">
                      <span style={{ width: `${p.value ?? 0}%` }} />
                    </span>
                    <span className="hint">{p.note}</span>
                  </li>
                ))}
              </ul>
              <p className="hint">Scored on the clip as you have it now. Don't trust it? Cut, trim and export: your edit wins.</p>
            </div>
          )}

          {panel === "versions" && <VersionsPanel info={info} locked={locked} reload={reload} setHist={setHist} setError={setError} />}
        </div>
      </div>
    </StudioShell>
  );
}

function Preview({
  clip,
  edit,
  words,
  playhead,
  editedNow,
  length,
  video,
  onCrop,
  onPlaying,
  onLoaded,
}: {
  clip: StudioInfo["clip"];
  edit: StudioEditInput;
  words: Word[];
  playhead: number;
  editedNow: number | null;
  length: number;
  video: React.RefObject<HTMLVideoElement | null>;
  onCrop: (x: number) => void;
  onPlaying: (p: boolean) => void;
  onLoaded: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState<number | null>(null);
  const style = edit.look.captionStyle;
  const cropX = dragX ?? edit.look.cropX ?? 0.5;
  // The caption line under the playhead: three words at a time, as the render sets them.
  const kept = words.filter((w) => w.startSec >= edit.startSec && w.endSec <= edit.endSec && !edit.cuts.some((c) => w.startSec >= c.startSec && w.endSec <= c.endSec));
  const at = kept.findIndex((w, i) => playhead >= w.startSec && playhead < (kept[i + 1]?.startSec ?? w.endSec));
  const line = at >= 0 ? kept.slice(at - (at % 3), at - (at % 3) + 3) : [];
  const fromX = (clientX: number) => {
    const r = frame.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 100) / 100;
  };
  const canCrop = edit.layout !== "full";
  return (
    <div
      ref={frame}
      className={`studio-frame layout-${edit.layout}`}
      onPointerDown={(e) => {
        if (!canCrop) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDragX(fromX(e.clientX));
      }}
      onPointerMove={(e) => dragX !== null && setDragX(fromX(e.clientX))}
      onPointerUp={() => {
        if (dragX !== null) onCrop(dragX);
        setDragX(null);
      }}
      title={canCrop ? "Drag across to move the crop" : undefined}
    >
      <video
        ref={video}
        src={clip.masterUrl}
        playsInline
        preload="auto"
        style={{ objectPosition: `${cropX * 100}% 50%` }}
        onLoadedMetadata={onLoaded}
        onPlay={() => onPlaying(true)}
        onPause={() => onPlaying(false)}
      />
      {edit.effects.progressBar && editedNow !== null && <span className="studio-progress" style={{ width: `${(editedNow / length) * 100}%` }} />}
      {edit.look.watermark && <span className="studio-mark">{edit.look.watermark}</span>}
      {edit.effects.hookCard && edit.hook && editedNow !== null && editedNow < HOOK_SEC && (
        <span className="studio-hook" style={{ background: style.hookColor }}>
          {edit.hook}
        </span>
      )}
      {edit.look.outro && editedNow !== null && editedNow > length - OUTRO_SEC && (
        <span className="studio-outro" style={{ background: style.hookColor }}>
          {edit.look.outro}
        </span>
      )}
      {line.length > 0 && (
        <span className={`studio-caption pos-${style.position}`} style={{ fontFamily: style.font, fontSize: `${style.size / 19.2}cqh`, color: style.color }} data-testid="caption-preview">
          {line.map((w, i) => (
            <span key={i} style={style.wordByWord && w === kept[at] ? { color: style.highlight } : undefined}>
              {w.word}{" "}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function LookPanel({
  info,
  edit,
  change,
  setLook,
  setStyle,
  account,
  goingTo,
  pickTemplate,
}: {
  info: StudioInfo;
  edit: StudioEditInput;
  change: (e: Partial<StudioEditInput>) => void;
  setLook: (l: Partial<ClipLook>) => void;
  setStyle: (s: Partial<CaptionStyle>) => void;
  account: string;
  goingTo: (id: string) => void;
  pickTemplate: (id: number) => void;
}) {
  const { source, ai, clip } = info;
  const style = edit.look.captionStyle;
  const [ideas, setIdeas] = useState<{ hook: string }[] | null>(null);
  const [ideaError, setIdeaError] = useState<string | null>(null);
  const applied = info.templates.find((t) => t.id === edit.look.templateId);
  const faceCamX = source.faceCam ? Math.round((source.faceCam.x + source.faceCam.w / 2) * 100) / 100 : null;

  async function getIdeas(withAi: boolean) {
    setIdeaError(null);
    try {
      setIdeas(await api.hookIdeas(clip.id, withAi));
    } catch (err) {
      setIdeaError((err as Error).message);
    }
  }

  return (
    <div role="tabpanel" aria-label="Look" className="form studio-look">
      <fieldset>
        <legend>Brand template</legend>
        <div className="row">
          <label>
            Going to
            <select value={account} onChange={(e) => goingTo(e.target.value)}>
              <option value="">Pick an account</option>
              {info.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.platform})
                </option>
              ))}
            </select>
          </label>
          <label>
            Template
            <select value={edit.look.templateId ?? ""} onChange={(e) => e.target.value && pickTemplate(Number(e.target.value))} data-testid="template-select">
              <option value="">{info.templates.length ? "None" : "None yet"}</option>
              {info.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="hint">
          {applied ? `Using “${applied.name}”. ` : ""}Picking the account applies its template. Make templates in <a href="#settings/templates">Settings</a>.
        </p>
      </fieldset>

      <fieldset className="layouts">
        <legend>Layout and crop</legend>
        <div className="chips">
          {CLIP_LAYOUTS.map((l) => {
            const blocked = l === "stacked" && !source.faceCam;
            return (
              <label key={l} className="chip">
                <input type="radio" name="studio-layout" checked={edit.layout === l} disabled={blocked} onChange={() => change({ layout: l as ClipLayout })} />
                {l === "stacked" ? "Split: face cam + gameplay" : CLIP_LAYOUT_LABELS[l]}
              </label>
            );
          })}
        </div>
        {edit.layout !== "full" && (
          <>
            <label>
              Crop position
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={edit.look.cropX ?? 0.5}
                onChange={(e) => setLook({ cropX: Number(e.target.value) })}
              />
            </label>
            <div className="chips">
              <button type="button" onClick={() => setLook({ cropX: faceCamX })}>
                Auto{faceCamX !== null ? ": on the streamer" : ": centre"}
              </button>
            </div>
            <p className="hint">Or drag across the picture. {source.faceCam ? "" : "Set the face cam in Sources for the split layout."}</p>
          </>
        )}
      </fieldset>

      <fieldset>
        <legend>Captions</legend>
        <div className="row">
          <label>
            Font
            <select value={style.font} onChange={(e) => setStyle({ font: e.target.value as CaptionStyle["font"] })}>
              {CAPTION_FONTS.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            Size {style.size}
            <input type="range" min={CAPTION_SIZE_MIN} max={CAPTION_SIZE_MAX} value={style.size} onChange={(e) => setStyle({ size: Number(e.target.value) })} />
          </label>
        </div>
        <div className="row studio-colours">
          <label>
            Text
            <input type="color" value={style.color} onChange={(e) => setStyle({ color: e.target.value.toUpperCase() })} />
          </label>
          <label>
            Word being said
            <input type="color" value={style.highlight} onChange={(e) => setStyle({ highlight: e.target.value.toUpperCase() })} />
          </label>
          <label>
            Hook box
            <input type="color" value={style.hookColor} onChange={(e) => setStyle({ hookColor: e.target.value.toUpperCase() })} />
          </label>
        </div>
        <div className="chips">
          {CAPTION_POSITIONS.map((p) => (
            <label key={p} className="chip">
              <input type="radio" name="studio-pos" checked={style.position === p} onChange={() => setStyle({ position: p })} />
              {CAPTION_POSITION_LABELS[p]}
            </label>
          ))}
          <label className="chip">
            <input type="checkbox" checked={style.wordByWord} onChange={(e) => setStyle({ wordByWord: e.target.checked })} />
            Highlight word by word
          </label>
        </div>
      </fieldset>

      <label>
        Hook (on screen for the first 1.5 s)
        <input value={edit.hook} maxLength={100} onChange={(e) => change({ hook: e.target.value })} />
      </label>
      <div className="chips">
        <button type="button" onClick={() => void getIdeas(false)}>
          Hook ideas
        </button>
        <button type="button" disabled={!ai.elements.hook.allowed} onClick={() => void getIdeas(true)}>
          Write one with AI
        </button>
      </div>
      {ideaError && (
        <p className="error" role="alert">
          {ideaError}
        </p>
      )}
      {ideas && (
        <div className="chips" data-testid="hook-ideas">
          {ideas.length === 0 && <span className="hint">No new ideas for this clip.</span>}
          {ideas.map((i) => (
            <button key={i.hook} type="button" className="chip-button" onClick={() => change({ hook: i.hook })}>
              {i.hook}
            </button>
          ))}
        </div>
      )}
      <label>
        Title
        <input value={edit.title} maxLength={100} onChange={(e) => change({ title: e.target.value })} />
      </label>

      <div className="row">
        <label>
          Watermark
          <input value={edit.look.watermark} maxLength={40} placeholder="@yourchannel" onChange={(e) => setLook({ watermark: e.target.value })} />
        </label>
        <label>
          Outro (last 1.5 s)
          <input value={edit.look.outro} maxLength={60} placeholder="Follow for part 2" onChange={(e) => setLook({ outro: e.target.value })} />
        </label>
      </div>

      <fieldset className="layouts">
        <legend>Finishing touches</legend>
        <div className="chips">
          {CLIP_EFFECTS.map((e) => (
            <label key={e} className="chip">
              <input type="checkbox" checked={edit.effects[e]} onChange={(ev) => change({ effects: { ...edit.effects, [e]: ev.target.checked } as ClipEffects })} />
              {CLIP_EFFECT_LABELS[e]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset data-testid="ai-gate">
        <legend>AI</legend>
        {ai.banned && <p className="studio-ban">{ai.reason}</p>}
        <ul className="ai-list">
          {AI_ELEMENTS.map((e) => (
            <li key={e} className={ai.elements[e].allowed ? "" : "off"}>
              <span>{AI_ELEMENT_LABELS[e]}</span>
              <span className="hint">
                {ai.elements[e].allowed
                  ? e === "hook"
                    ? "Allowed: Write one with AI."
                    : e === "thumbnails"
                      ? "Allowed: Approved › Thumbnail."
                      : "Allowed. clipfarm adds no voice-over yet."
                  : "Off for this campaign."}
              </span>
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}

function VersionsPanel({
  info,
  locked,
  reload,
  setHist,
  setError,
}: {
  info: StudioInfo;
  locked: boolean;
  reload: () => Promise<StudioInfo>;
  setHist: (h: History<StudioEditInput>) => void;
  setError: (e: string | null) => void;
}) {
  const current = info.versions.find((v) => v.current) ?? null;
  const [playing, setPlaying] = useState<ClipVersion | null>(current);
  const shown = playing && info.versions.some((v) => v.id === playing.id) ? playing : current;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      const next = await reload();
      setHist(start(editOf(next)));
      setPlaying(next.versions.find((v) => v.current) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div role="tabpanel" aria-label="Versions" className="studio-versions">
      {info.clip.status === "rendering" && <p className="hint">Making the new version…</p>}
      {shown ? (
        <video key={shown.videoUrl} className="studio-version-video" src={shown.videoUrl} controls playsInline preload="metadata" data-testid="version-video" />
      ) : (
        <video key={info.clip.videoUrl} className="studio-version-video" src={info.clip.videoUrl} controls playsInline preload="metadata" />
      )}
      {info.versions.length === 0 ? (
        <p className="hint">Each export is kept here, so you can always go back. Nothing is exported yet.</p>
      ) : (
        <ul className="version-list">
          {info.versions.map((v) => (
            <li key={v.id} className={v.current ? "current" : ""}>
              <button type="button" className="link" onClick={() => setPlaying(v)}>
                {v.label}
              </button>
              <span className="hint">
                {fmt(v.durationSec)}
                {v.current ? ", in use" : ""}
              </span>
              {!v.current && (
                <button type="button" disabled={locked} onClick={() => void act(() => api.restoreVersion(info.clip.id, v.id))}>
                  Use this
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {info.versions.length > 0 && (
        <button type="button" disabled={locked || info.versions.at(-1)?.current} onClick={() => void act(() => api.revertClip(info.clip.id))}>
          Revert to original
        </button>
      )}
    </div>
  );
}
