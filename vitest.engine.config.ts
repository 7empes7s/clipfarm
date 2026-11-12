import { defineConfig } from "vitest/config";

/**
 * The slow tests that run the real local engine (whisper.cpp, and with ENGINE_WRITER=1 the hook
 * writer on llama.cpp) on speech generated in the test. They download the pinned programs and
 * models once into data/engine-test (never into git).
 */
export default defineConfig({
  test: {
    include: [process.env.ENGINE_WRITER === "1" ? "test/real/writer.real.ts" : "test/real/engine.real.ts"],
    environment: "node",
    testTimeout: 20 * 60_000,
    hookTimeout: 20 * 60_000,
    fileParallelism: false,
  },
});
