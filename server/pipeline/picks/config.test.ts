import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";

describe("picker settings", () => {
  it("uses the fakes in demo mode and the local engine otherwise, with or without a key", () => {
    expect(loadConfig({ CLIPFARM_FAKES: "1" }).picker.name).toBe("fake");
    expect(loadConfig({}).picker.name).toBe("local");
    expect(loadConfig({}).transcriber.name).toBe("local:base.en");
    expect(loadConfig({ LLM_API_KEY: "k", LLM_MODEL: "llama-test", OPENAI_API_KEY: "k" }).picker.name).toBe("local");
    expect(loadConfig({ OPENAI_API_KEY: "k", MAX_PICKS: "" }).maxPicks).toBe(15);
  });

  it("keeps cloud AI as an option only when a key is set", () => {
    expect(loadConfig({}).engine.status([]).cloudAvailable).toBe(false);
    expect(loadConfig({ OPENAI_API_KEY: "k" }).engine.status([]).cloudAvailable).toBe(true);
  });

  it("keeps the models under DATA_DIR/models", () => {
    const { engine } = loadConfig({ DATA_DIR: "/var/lib/clipfarm", WHISPER_BIN: "" });
    expect(engine.pathOf({ id: "base.en", kind: "stt", label: "", url: "https://example.com/x/ggml-base.en.bin", sha256: "", bytes: 1 })).toBe(
      "/var/lib/clipfarm/models/ggml-base.en.bin",
    );
  });
});
