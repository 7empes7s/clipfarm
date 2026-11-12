import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";

describe("picker settings", () => {
  it("uses the fakes in demo mode and the LLM otherwise", () => {
    expect(loadConfig({ CLIPFARM_FAKES: "1" }).picker.name).toBe("fake");
    expect(loadConfig({ LLM_API_KEY: "k", LLM_MODEL: "llama-test" }).picker.name).toBe("llm:llama-test");
    expect(loadConfig({ OPENAI_API_KEY: "k", MAX_PICKS: "" }).maxPicks).toBe(15);
  });

  it("fails picking plainly without a key instead of picking without spoiler checks", async () => {
    const { picker } = loadConfig({ LLM_API_KEY: "" });
    await expect(
      picker.pick({
        title: null, durationSec: 0, chapters: [], words: [], signals: { loudness: [], chat: null },
        creatorName: "x", briefRules: "", bannedContent: "", maxPicks: 1,
      }),
    ).rejects.toThrow("LLM_API_KEY is not set");
  });
});
