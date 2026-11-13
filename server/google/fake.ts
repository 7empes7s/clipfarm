import type { GeminiClient, GeminiImageRequest, GeminiJsonRequest, GeminiUsage } from "./client.js";

/**
 * A scripted Gemini for tests and demo mode: answers what it is given, records the requests and
 * never touches the network. Without a script it gives a mild video read and hands the frame back
 * as the "generated" picture.
 */
export class FakeGemini implements GeminiClient {
  readonly flashModel = "fake-flash";
  readonly imageModel = "fake-image";
  readonly jsonCalls: GeminiJsonRequest[] = [];
  readonly imageCalls: GeminiImageRequest[] = [];

  constructor(
    private answers: { json?: (req: GeminiJsonRequest) => unknown; image?: (req: GeminiImageRequest) => Buffer | Promise<Buffer> } = {},
    private tokens = { in: 3000, out: 100 },
  ) {}

  async generateJson(req: GeminiJsonRequest): Promise<{ text: string } & GeminiUsage> {
    this.jsonCalls.push(req);
    const answer = this.answers.json
      ? this.answers.json(req)
      : { visual_intensity: 5, moment_type: "other", opens_on_payoff: true, best_start: 3, best_end: 30, flags: { spoiler: false, leak: false, cutscene: false } };
    return { text: JSON.stringify(answer), model: this.flashModel, inTokens: this.tokens.in, outTokens: this.tokens.out };
  }

  async generateImage(req: GeminiImageRequest): Promise<{ image: Buffer; mimeType: string } & GeminiUsage> {
    this.imageCalls.push(req);
    const image = this.answers.image ? await this.answers.image(req) : req.image.data;
    return { image, mimeType: req.image.mimeType, model: this.imageModel, inTokens: 300, outTokens: 1290 };
  }
}
