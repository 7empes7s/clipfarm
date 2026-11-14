import { join } from "node:path";
import type { CampaignRules, CaptionFix, Word } from "../../../shared/types.js";
import { extractAudio } from "../../tools/ffmpeg.js";
import type { ChatClient } from "../picks/llm.js";
import type { Transcriber } from "../transcript/types.js";
import { captionFixGate, changesBetween, correctCaptions, fixText } from "./correct.js";
import { seedGlossary, sttPrompt } from "./glossary.js";

/**
 * Accurate captions for a clip that is going to be posted. The first pass (Moonshine, cheap, for
 * scanning and picks) is replaced by the most accurate engine we have, prompted with the source's
 * glossary; then the correction pass fixes misheard words; then the hook and title are rebuilt from
 * the corrected words. Each step that cannot run or fails is skipped with a note: the clip still renders.
 */

export interface AccuracyDeps {
  /** The most accurate speech-to-text (cloud, word timings); null when no key is set. */
  transcriber: () => Transcriber | null;
  /** The model for the correction pass; null when none is set up. */
  chat: () => ChatClient | null;
}

export interface ImproveInput {
  /** The clip's section (its master); `words` are timed from its start. */
  input: string;
  durationSec: number;
  words: Word[];
  creatorName: string;
  /** What the glossary is seeded from: the source's video titles, campaign briefs. */
  texts: string[];
  vodTitle: string | null;
  permissions: { briefRules: string; rules: Pick<CampaignRules, "aiBanned"> | null }[];
  hook: string;
  title: string;
  tmpDir: string;
  signal?: AbortSignal;
  /** Cuts the section's audio (tests skip ffmpeg). */
  extract?: typeof extractAudio;
}

export interface Improved {
  words: Word[];
  fixes: CaptionFix[];
  hook: string;
  title: string;
  /** What the accurate engine and the correction cost, for the cost per clip. */
  costUsd: number;
  /** What happened, in plain words, for the log. */
  notes: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function improveCaptions(deps: AccuracyDeps, o: ImproveInput): Promise<Improved> {
  const glossary = seedGlossary({ creatorName: o.creatorName, texts: o.texts });
  const notes: string[] = [];
  let words = o.words;
  let costUsd = 0;

  const stt = deps.transcriber();
  if (stt) {
    try {
      const audio = join(o.tmpDir, "captions.mp3");
      await (o.extract ?? extractAudio)(o.input, audio, { signal: o.signal });
      const heard = await stt.transcribe(audio, { durationSec: o.durationSec, tmpDir: o.tmpDir, signal: o.signal, prompt: sttPrompt(glossary) });
      costUsd += heard.costUsd;
      if (heard.words.length > 0) {
        words = heard.words;
        notes.push(`Captions transcribed again by ${heard.model ?? stt.name} with the source's glossary.`);
      } else notes.push(`${heard.model ?? stt.name} heard no words; the first transcript is kept.`);
    } catch (err) {
      o.signal?.throwIfAborted();
      notes.push(`The accurate speech-to-text failed (${message(err)}); the first transcript is kept.`);
    }
  }

  // The hook and title were written from the first transcript: what the accurate engine heard
  // differently goes into them, as well as the corrections below.
  const heardBetter = words === o.words ? [] : changesBetween(o.words, words);
  let fixes: CaptionFix[] = [];
  const gate = captionFixGate(o.permissions);
  const chat = deps.chat();
  if (!gate.allowed) notes.push(gate.why!);
  else if (chat) {
    try {
      const out = await correctCaptions({ words, glossary, chat, context: { creatorName: o.creatorName, title: o.vodTitle }, signal: o.signal });
      words = out.words;
      fixes = out.fixes;
      costUsd += out.costUsd;
      notes.push(
        `${fixes.length} misheard word${fixes.length === 1 ? "" : "s"} fixed${out.rejected.length ? `, ${out.rejected.length} suggestion(s) refused (${out.rejected.map((r) => r.why).join("; ")})` : ""}.`,
      );
    } catch (err) {
      o.signal?.throwIfAborted();
      notes.push(`The caption correction failed (${message(err)}); the captions are as heard.`);
    }
  }

  const rebuild = (text: string) => fixText(fixText(text, heardBetter), fixes);
  return { words, fixes, hook: rebuild(o.hook), title: rebuild(o.title), costUsd: Math.round(costUsd * 1e6) / 1e6, notes };
}
