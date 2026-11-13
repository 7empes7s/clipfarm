import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { rm } from "node:fs/promises";
import { LINK_TO_CLIPS_GOAL_MS } from "./settings.js";

/** The name of the attachment the link-to-clips step leaves with its time in ms. */
export const LINK_TO_CLIPS_ATTACHMENT = "link-to-clips-ms";

export interface StepRow {
  step: string;
  project: string;
  status: TestResult["status"];
  ms: number;
}

function took(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function cell(row: StepRow | undefined): string {
  if (!row || row.status === "skipped") return "not run";
  return `${row.status === "passed" ? "pass" : "FAIL"} ${took(row.ms)}`;
}

/** The pass/fail table: one line per step, one column per screen size, then the O1 time and the result. */
export function stepTable(input: { target: string; projects: string[]; rows: StepRow[]; linkToClipsMs: Record<string, number> }): string {
  const { target, projects, rows, linkToClipsMs } = input;
  const steps = [...new Set(rows.map((r) => r.step))];
  const table = [
    ["Step", ...projects],
    ...steps.map((step) => [step, ...projects.map((p) => cell(rows.find((r) => r.step === step && r.project === p)))]),
  ];
  const widths = table[0]!.map((_, col) => Math.max(...table.map((line) => line[col]!.length)));
  const lines = table.map((line) => `| ${line.map((text, col) => text.padEnd(widths[col]!)).join(" | ")} |`);
  lines.splice(1, 0, `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);

  const failed = rows.filter((r) => r.status !== "passed" && r.status !== "skipped").length;
  const notRun = rows.filter((r) => r.status === "skipped").length;
  const plural = (n: number) => `${n} step${n === 1 ? "" : "s"}`;
  const result =
    failed + notRun === 0 ? "PASS" : `FAIL (${[failed ? `${plural(failed)} failed` : "", notRun ? `${notRun} not run` : ""].filter(Boolean).join(", ")})`;
  const timed = projects
    .filter((p) => linkToClipsMs[p] !== undefined)
    .map((p) => `${p} ${took(linkToClipsMs[p]!)}, ${linkToClipsMs[p]! < LINK_TO_CLIPS_GOAL_MS ? "within the goal" : "OVER the goal"}`);
  return [
    `clipfarm end to end: ${target}`,
    "",
    ...lines,
    "",
    `Link to clips (goal: under 30 min): ${timed.length ? timed.join("; ") : "not measured"}`,
    `Result: ${result}`,
  ].join("\n");
}

/** Prints the table when the run ends, then removes the folder of the preview the run started and, after a pass, its empty output folder. */
export default class StepTableReporter implements Reporter {
  private rows: StepRow[] = [];
  private linkToClipsMs: Record<string, number> = {};
  private projects: string[] = [];
  private target = "";
  private passed = false;

  constructor(private options: { previewDir?: string; outputDir?: string } = {}) {}

  onBegin(config: FullConfig): void {
    this.projects = config.projects.map((p) => p.name);
    const meta = config.metadata as { target?: string };
    this.target = meta.target ?? "";
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? "";
    // A retry replaces the earlier try's line.
    this.rows = this.rows.filter((r) => !(r.step === test.title && r.project === project));
    this.rows.push({ step: test.title, project, status: result.status, ms: result.duration });
    const timing = result.attachments.find((a) => a.name === LINK_TO_CLIPS_ATTACHMENT)?.body;
    if (timing) this.linkToClipsMs[project] = Number(timing.toString());
  }

  onEnd(result: FullResult): void {
    this.passed = result.status === "passed";
    // --project=phone leaves the other screen out of the table.
    const projects = this.projects.filter((p) => this.rows.some((r) => r.project === p));
    console.log(`\n${stepTable({ target: this.target, projects, rows: this.rows, linkToClipsMs: this.linkToClipsMs })}\n`);
  }

  /** Called after Playwright has stopped the preview, pass or fail, so nothing writes to the folder again. */
  async onExit(): Promise<void> {
    if (this.options.previewDir) await rm(this.options.previewDir, { recursive: true, force: true });
    // A failed run keeps its traces; a passed one has nothing worth keeping.
    if (this.passed && this.options.outputDir) await rm(this.options.outputDir, { recursive: true, force: true });
  }
}
