import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Word } from "../../shared/types.js";
import type { StepResult } from "../pipeline/transcript/chain.js";
import { assertMemoryFor, type MemoryReading } from "./memory.js";
import { runTracked } from "./proc.js";

/** What Moonshine (MIT, https://github.com/moonshine-ai/moonshine) needs to run. */
export interface MoonshineSetup {
  /** Python 3 (standard library only), which loads the library. */
  python: string;
  /** Moonshine's own `libmoonshine.so`, with ONNX Runtime next to it. */
  lib: string;
  /** The folder with the model's files. */
  modelDir: string;
  modelId: string;
  /** Moonshine's number for the model's architecture (0 tiny, 1 base). */
  arch: number;
  needMb: number;
}

/**
 * The sidecar: a few lines of Python (standard library only) that load Moonshine's library, hand
 * it one 16 kHz mono WAV and write the lines it heard, with word times, as JSON. It runs as its
 * own short process per segment, so its memory goes back to the box and a stuck run can be killed.
 */
export const MOONSHINE_SIDECAR = String.raw`
import array, ctypes as C, json, sys, wave
lib_path, model_dir, arch, wav_path, out_path = sys.argv[1:6]
class Opt(C.Structure):
    _fields_ = [("name", C.c_char_p), ("value", C.c_char_p)]
class Word(C.Structure):
    _fields_ = [("text", C.c_char_p), ("start", C.c_float), ("end", C.c_float), ("confidence", C.c_float)]
class Line(C.Structure):
    _fields_ = [("text", C.c_char_p), ("audio_data", C.c_void_p), ("audio_data_count", C.c_size_t),
                ("start_time", C.c_float), ("duration", C.c_float), ("id", C.c_uint64),
                ("is_complete", C.c_int8), ("is_updated", C.c_int8), ("is_new", C.c_int8),
                ("has_text_changed", C.c_int8), ("have_speakers_changed", C.c_int8),
                ("speaker_spans", C.c_void_p), ("speaker_span_count", C.c_uint64),
                ("last_transcription_latency_ms", C.c_uint32),
                ("words", C.POINTER(Word)), ("word_count", C.c_uint64)]
class Transcript(C.Structure):
    _fields_ = [("lines", C.POINTER(Line)), ("line_count", C.c_uint64)]
lib = C.CDLL(lib_path)
lib.moonshine_error_to_string.restype = C.c_char_p
lib.moonshine_load_transcriber_from_files.argtypes = [C.c_char_p, C.c_uint32, C.POINTER(Opt), C.c_uint64, C.c_int32]
lib.moonshine_transcribe_without_streaming.argtypes = [C.c_int32, C.POINTER(C.c_float), C.c_uint64, C.c_int32, C.c_uint32, C.POINTER(C.POINTER(Transcript))]
def fail(what):
    sys.stderr.write("Moonshine: %s\n" % what)
    sys.exit(1)
def text(raw):
    return (raw or b"").decode("utf-8", "replace")
with wave.open(wav_path, "rb") as w:
    if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
        fail("the audio must be 16 kHz mono 16-bit WAV")
    pcm = array.array("h")
    pcm.frombytes(w.readframes(w.getnframes()))
if sys.byteorder == "big":
    pcm.byteswap()
opts = (Opt * 1)(Opt(b"word_timestamps", b"true"))
handle = lib.moonshine_load_transcriber_from_files(model_dir.encode(), int(arch), opts, 1, 30000)
if handle < 0:
    fail("the model did not load (%s)" % text(lib.moonshine_error_to_string(handle)))
audio = (C.c_float * len(pcm))(*[s / 32768.0 for s in pcm])
out = C.POINTER(Transcript)()
code = lib.moonshine_transcribe_without_streaming(handle, audio, len(pcm), 16000, 0, C.byref(out))
if code != 0:
    fail(text(lib.moonshine_error_to_string(code)))
lines = []
for i in range(out.contents.line_count if out else 0):
    l = out.contents.lines[i]
    lines.append({"text": text(l.text), "start": l.start_time, "duration": l.duration,
                  "words": [{"word": text(l.words[j].text), "start": l.words[j].start, "end": l.words[j].end,
                             "confidence": l.words[j].confidence} for j in range(l.word_count)]})
with open(out_path, "w") as f:
    json.dump({"lines": lines}, f)
`;

interface MoonshineJson {
  lines?: { text?: string; start?: number; duration?: number; words?: { word?: string; start?: number; end?: number; confidence?: number }[] }[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Turns the sidecar's JSON into words with times, the average confidence, and how much of the
 * speech Moonshine found it had no words for (a line with empty text is speech it could not read).
 */
export function readMoonshineJson(json: string): StepResult {
  let body: MoonshineJson;
  try {
    body = JSON.parse(json) as MoonshineJson;
  } catch {
    throw new Error("Moonshine did not write a readable transcript.");
  }
  const words: Word[] = [];
  let confidence = 0;
  let heardSec = 0;
  let silentSec = 0;
  for (const line of body.lines ?? []) {
    const lineSec = Math.max(0, line.duration ?? 0);
    heardSec += lineSec;
    const said = (line.words ?? []).filter((w) => typeof w.word === "string" && w.word.trim() && typeof w.start === "number" && typeof w.end === "number");
    if (said.length === 0) {
      silentSec += lineSec;
      continue;
    }
    for (const w of said) {
      const startSec = Math.max(0, w.start!);
      words.push({ word: w.word!.trim(), startSec: round(startSec), endSec: round(Math.max(w.end!, startSec + 0.02)) });
      confidence += typeof w.confidence === "number" ? w.confidence : 1;
    }
  }
  return { words, confidence: words.length > 0 ? confidence / words.length : null, heardSec: round(heardSec), silentSec: round(silentSec), language: "en" };
}

/** One Moonshine run over a 16 kHz mono WAV. Refuses to start when the box is short on memory (the guard). */
export async function runMoonshine(
  setup: MoonshineSetup,
  wavPath: string,
  opts: { tmpDir: string; signal?: AbortSignal },
  memory: MemoryReading,
): Promise<StepResult> {
  assertMemoryFor(`the speech model (Moonshine ${setup.modelId})`, setup.needMb, memory);
  const out = join(opts.tmpDir, "moonshine.json");
  // -I: Python ignores the environment and the current folder, so only its own library is loaded.
  const { peakRssMb } = await runTracked(
    setup.python,
    ["-I", "-c", MOONSHINE_SIDECAR, setup.lib, setup.modelDir, String(setup.arch), wavPath, out],
    { signal: opts.signal },
  );
  return { ...readMoonshineJson(await readFile(out, "utf8")), peakRssMb };
}
