import { DEFAULT_PICK_MODEL, DEFAULT_PICK_USD_PER_MTOK, isOpenAiAddress, type OpenAiCompatibleChatOptions } from "../pipeline/picks/llm.js";
import { DEFAULT_TRANSCRIBE_MODEL, OPENAI_BASE_URL, WORD_TIMING_MODEL } from "../pipeline/transcript/openai.js";
import type { Settings } from "./store.js";

/** What the last OpenAI test learned. Kept with the saved keys, so it survives a restart. */
export interface OpenAiFacts {
  /** Every model the picking address listed. */
  pickModels: string[];
  /** Every model OpenAI listed (transcription always goes to OpenAI). */
  openAiModels: string[];
  /** The transcription model that was tried on the 2-second sample, and whether it sent word timings. */
  probe: { model: string; wordTimings: boolean } | null;
}

/** Defaults this app once wrote into the server env file. Left there, they must not pin picks to a retired model. */
const OLD_ENV_MODELS = ["gpt-4o-mini"];

/** What a model list holds besides text models, by the usual words in their names. */
const NOT_TEXT = /embed|whisper|transcri|tts|audio|speech|image|dall-e|moderation|realtime|sora|video|rerank/i;
const SPEECH_TO_TEXT = /whisper|transcri/i;

export interface OpenAiSetup {
  /** Where picks are sent, without a trailing slash. */
  baseUrl: string;
  /** OpenAI's own address (Responses API), or an OpenAI-compatible one (Chat Completions). */
  official: boolean;
  model: string;
  modelSource: "settings" | "env" | "default";
  /** A retired default still set in the server env, which is not used. */
  oldEnvModel: string | null;
  /** The transcription model chosen (or the default), and the one jobs really use. */
  transcribeChoice: string;
  transcribeChoiceSource: "settings" | "env" | "default";
  transcribeModel: string;
}

/** The models in use right now: the choice saved in Settings, else the server env, else the default. */
export function openAiSetup(settings: Settings): OpenAiSetup {
  const env = settings.env();
  const baseUrl = (env.LLM_BASE_URL || OPENAI_BASE_URL).replace(/\/+$/, "");
  const official = isOpenAiAddress(baseUrl);
  const envModel = settings.serverEnv().LLM_MODEL || undefined;
  const oldEnvModel = official && envModel && OLD_ENV_MODELS.includes(envModel) ? envModel : null;
  const saved = settings.source("LLM_MODEL") === "settings";
  const named = saved ? env.LLM_MODEL : oldEnvModel ? undefined : envModel;
  const transcribeChoice = env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
  const probe = settings.openAiFacts()?.probe;
  return {
    baseUrl,
    official,
    model: named ?? DEFAULT_PICK_MODEL,
    modelSource: saved ? "settings" : named ? "env" : "default",
    oldEnvModel,
    transcribeChoice,
    transcribeChoiceSource: settings.source("OPENAI_TRANSCRIBE_MODEL") ?? "default",
    // Known from the last test to send no word timings: straight to whisper-1, no wasted upload per job.
    transcribeModel: probe?.model === transcribeChoice && !probe.wordTimings ? WORD_TIMING_MODEL : transcribeChoice,
  };
}

/** How to reach the picking model; null without a key. */
export function pickChatOptions(settings: Settings): OpenAiCompatibleChatOptions | null {
  const env = settings.env();
  const apiKey = env.LLM_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const { baseUrl, model } = openAiSetup(settings);
  const listed = model === DEFAULT_PICK_MODEL ? DEFAULT_PICK_USD_PER_MTOK : { in: 0, out: 0 };
  return {
    apiKey,
    baseUrl,
    model,
    usdPerMTokIn: Number(env.LLM_USD_PER_MTOK_IN || listed.in),
    usdPerMTokOut: Number(env.LLM_USD_PER_MTOK_OUT || listed.out),
  };
}

function ordered(ids: string[], first: string[]): string[] {
  const rest = [...new Set(ids)].filter((id) => !first.includes(id)).sort();
  return [...first.filter((id) => ids.includes(id)), ...rest];
}

/** The picking dropdown: text models only, the recommended one first. */
export function pickModelOptions(facts: OpenAiFacts): string[] {
  return ordered(
    facts.pickModels.filter((id) => !NOT_TEXT.test(id)),
    [DEFAULT_PICK_MODEL],
  );
}

/** The transcription dropdown: speech-to-text models only, the recommended one first. */
export function transcribeModelOptions(facts: OpenAiFacts): string[] {
  return ordered(
    facts.openAiModels.filter((id) => SPEECH_TO_TEXT.test(id)),
    [DEFAULT_TRANSCRIBE_MODEL, WORD_TIMING_MODEL],
  );
}

/** A stand-in model list for demo mode, where nothing outside is called. */
export const DEMO_FACTS: OpenAiFacts = {
  pickModels: [DEFAULT_PICK_MODEL, "demo-large", "demo-balanced", DEFAULT_TRANSCRIBE_MODEL, WORD_TIMING_MODEL],
  openAiModels: [DEFAULT_PICK_MODEL, "demo-large", "demo-balanced", DEFAULT_TRANSCRIBE_MODEL, WORD_TIMING_MODEL],
  probe: { model: DEFAULT_TRANSCRIBE_MODEL, wordTimings: false },
};

/** What the Settings card says under the OpenAI values. */
export function openAiNotes(settings: Settings): string[] {
  const setup = openAiSetup(settings);
  const notes: string[] = [];
  if (setup.oldEnvModel) {
    notes.push(
      setup.modelSource === "settings"
        ? `Old model in server env (${setup.oldEnvModel}), replaced by your choice.`
        : `Old model in server env (${setup.oldEnvModel}), replaced by ${setup.model}.`,
    );
  }
  if (setup.transcribeModel === WORD_TIMING_MODEL) {
    const why = setup.transcribeChoice === WORD_TIMING_MODEL ? "" : ` because ${setup.transcribeChoice} does not send word timings yet`;
    notes.push(`Transcription uses ${WORD_TIMING_MODEL} for word timings${why}. ${WORD_TIMING_MODEL} retires on 26 Feb 2027.`);
  }
  return notes;
}
