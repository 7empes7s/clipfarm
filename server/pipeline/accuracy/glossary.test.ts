import { describe, expect, it } from "vitest";
import { seedGlossary, sttPrompt, TRADING_TERMS } from "./glossary.js";

describe("seedGlossary", () => {
  it("seeds a trading creator with the market words from their titles and campaign brief", () => {
    const g = seedGlossary({
      creatorName: "TJR",
      texts: ["TJR LIVE: trading NQ and ES futures at the open", "Clip TJR's day trading streams. Tag @TJRTrades #daytrading"],
    });
    expect(g.domains).toEqual(["trading"]);
    expect(g.terms[0]).toBe("TJR");
    for (const t of ["market", "futures", "NQ", "ES", "SPY", "liquidity", "FVG", "the open", "pre-market"]) expect(g.terms).toContain(t);
    // Handles and hashtags from the brief are names worth hearing right.
    expect(g.terms).toContain("TJRTrades");
    // Each term once, whatever its case.
    expect(new Set(g.terms.map((t) => t.toLowerCase())).size).toBe(g.terms.length);
  });

  it("adds no domain words when nothing points to one, and keeps tickers and names from the titles", () => {
    const g = seedGlossary({ creatorName: "Kai", texts: ["Kai reacts to the new GTA trailer with IShowSpeed"] });
    expect(g.terms).not.toContain(TRADING_TERMS[0]);
    expect(g.domains).toEqual(["gta"]);
    expect(g.terms).toEqual(expect.arrayContaining(["Kai", "GTA", "IShowSpeed"]));
  });
});

describe("sttPrompt", () => {
  it("lists the terms for the speech-to-text and stays short enough for its prompt", () => {
    const g = seedGlossary({ creatorName: "TJR", texts: ["day trading futures"] });
    const p = sttPrompt(g);
    expect(p.startsWith("TJR, ")).toBe(true);
    expect(p).toContain("market");
    expect(p.length).toBeLessThanOrEqual(600);
    expect(sttPrompt({ terms: Array.from({ length: 400 }, (_, i) => `word${i}`), domains: [] }).length).toBeLessThanOrEqual(600);
    expect(sttPrompt({ terms: [], domains: [] })).toBe("");
  });
});
