/**
 * Everything the local engine downloads, pinned to one release and one SHA-256 each.
 * - whisper.cpp (MIT, https://github.com/ggml-org/whisper.cpp): speech-to-text on the CPU, ready-made Linux builds.
 * - Silero VAD (MIT, https://github.com/snakers4/silero-vad) in whisper.cpp's format: finds the speech, so silence is skipped.
 * - llama.cpp (MIT, https://github.com/ggml-org/llama.cpp): runs the small model that writes hooks and titles.
 * - Whisper models (MIT, OpenAI) and Qwen2.5-1.5B-Instruct (Apache-2.0, Alibaba Cloud).
 */
export type PartKind = "stt-runtime" | "vad" | "stt" | "llm-runtime" | "llm";

export interface EnginePartSpec {
  id: string;
  kind: PartKind;
  /** Plain name shown in the app. */
  label: string;
  url: string;
  sha256: string;
  bytes: number;
  /** For a program: the file to run inside the unpacked archive. Models are a single file. */
  bin?: string;
  /** Memory the model needs while it runs, in MB (measured on the 4-vCPU box; the guard adds 1 GB spare). */
  needMb?: number;
  /** Shown next to a model choice. */
  note?: string;
}

const WHISPER_MODELS = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1";
const WHISPER_RELEASE = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454";
const LLAMA_RELEASE = "https://github.com/ggml-org/llama.cpp/releases/download/b12328";

/** Ready-made programs exist for Linux on these processors; elsewhere WHISPER_BIN / LLAMA_SERVER_BIN point at your own. */
const RUNTIMES: Record<string, EnginePartSpec[]> = {
  "linux-x64": [
    {
      id: "whisper-cpp",
      kind: "stt-runtime",
      label: "Speech-to-text program (whisper.cpp)",
      url: `${WHISPER_RELEASE}/whisper-bin-ubuntu-x64.tar.gz`,
      sha256: "a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c",
      bytes: 10364195,
      bin: "whisper-cli",
    },
    {
      id: "llama-cpp",
      kind: "llm-runtime",
      label: "Hook writer program (llama.cpp)",
      url: `${LLAMA_RELEASE}/llama-b12328-bin-ubuntu-x64.tar.gz`,
      sha256: "96cbced54f9adc53e11b5165bcc05717c9185155953aee7eeece2af981f74255",
      bytes: 23329789,
      bin: "llama-server",
    },
  ],
  "linux-arm64": [
    {
      id: "whisper-cpp",
      kind: "stt-runtime",
      label: "Speech-to-text program (whisper.cpp)",
      url: `${WHISPER_RELEASE}/whisper-bin-ubuntu-arm64.tar.gz`,
      sha256: "6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149",
      bytes: 4608377,
      bin: "whisper-cli",
    },
    {
      id: "llama-cpp",
      kind: "llm-runtime",
      label: "Hook writer program (llama.cpp)",
      url: `${LLAMA_RELEASE}/llama-b12328-bin-ubuntu-arm64.tar.gz`,
      sha256: "9386d77e73b08833cfa1472b23a39cb593e57c6ce70091a09a3e6b33370a022f",
      bytes: 18964316,
      bin: "llama-server",
    },
  ],
};

const MODELS: EnginePartSpec[] = [
  {
    id: "silero-vad",
    kind: "vad",
    label: "Speech finder (Silero VAD)",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    bytes: 885098,
  },
  {
    id: "tiny.en",
    kind: "stt",
    label: "Speech model tiny.en",
    url: `${WHISPER_MODELS}/ggml-tiny.en.bin`,
    sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    bytes: 77704715,
    needMb: 400,
    note: "Fastest, mishears more",
  },
  {
    id: "base.en",
    kind: "stt",
    label: "Speech model base.en",
    url: `${WHISPER_MODELS}/ggml-base.en.bin`,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    bytes: 147964211,
    needMb: 500,
    note: "Best for this server: about 6 min per hour of stream",
  },
  {
    id: "small.en",
    kind: "stt",
    label: "Speech model small.en",
    url: `${WHISPER_MODELS}/ggml-small.en.bin`,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    bytes: 487614201,
    needMb: 1100,
    note: "Most accurate, about 3 times slower",
  },
  {
    id: "qwen2.5-1.5b",
    kind: "llm",
    label: "Hook writer model (Qwen2.5 1.5B)",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    bytes: 1117320736,
    needMb: 1900,
  },
];

export const DEFAULT_STT_MODEL = "base.en";
export const DEFAULT_LLM_MODEL = "qwen2.5-1.5b";

export function defaultCatalog(platform: string = process.platform, arch: string = process.arch): EnginePartSpec[] {
  return [...(RUNTIMES[`${platform}-${arch}`] ?? []), ...MODELS];
}
