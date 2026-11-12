import { candidateWindows, secondScores } from "./signals.js";
import { toSentences } from "./sentences.js";
import { type ChatClient, type ChatRequest, type ChatResponse } from "./llm.js";
import { NO_FLAGS, type PickInput, type Picker, type PickerResult } from "./types.js";

/** A scripted chat model for tests: returns whatever the test gives it and records the requests. */
export class FakeChatClient implements ChatClient {
  readonly name = "fake-llm";
  readonly requests: ChatRequest[] = [];

  constructor(private answer: (req: ChatRequest) => unknown, private costUsd = 0) {}

  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    return { content: JSON.stringify(this.answer(req)), costUsd: this.costUsd };
  }
}

/** Demos and e2e (no API): takes the loudest signal windows as they are, with plain titles. */
export class FakePicker implements Picker {
  readonly name = "fake";

  async pick(input: PickInput): Promise<PickerResult> {
    const scores = secondScores(input.durationSec, input.words, input.signals);
    const candidates = candidateWindows(scores, toSentences(input.words), { count: input.maxPicks });
    return {
      costUsd: 0,
      picks: candidates.map((c, i) => ({
        startSec: c.startSec,
        endSec: c.endSec,
        hook: "Wait for it",
        title: `${input.creatorName} moment ${i + 1}`,
        score: Math.max(0, 80 - i * 5),
        reason: `Loudest moment number ${i + 1} (test picker, no AI)`,
        layout: "center",
        flags: NO_FLAGS,
      })),
    };
  }
}
