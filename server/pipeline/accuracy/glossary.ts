/**
 * A source's vocabulary: the creator's name, the names and tickers in their video titles and campaign
 * brief, and the words of their field (trading, GTA). It is handed to the speech-to-text as its
 * prompt, and to the correction pass, so "market" is not heard as "Margaret".
 */

export interface Glossary {
  terms: string[];
  /** The fields the source talks about, e.g. "trading". */
  domains: string[];
}

export const TRADING_TERMS = [
  "market", "futures", "NQ", "ES", "SPY", "QQQ", "Nasdaq", "S&P", "liquidity", "FVG", "fair value gap", "the open",
  "pre-market", "order block", "candle", "stop loss", "take profit", "long", "short", "bullish", "bearish", "CPI", "FOMC",
];
export const GTA_TERMS = ["GTA", "GTA VI", "Rockstar", "Vice City", "Leonida", "Lucia", "Jason"];

const DOMAINS: { id: string; cue: RegExp; terms: string[] }[] = [
  { id: "trading", cue: /\b(trad(e|es|ing|er|ers)|futures|stocks?|forex|scalp\w*|market open|NQ|SPY|nasdaq)\b/i, terms: TRADING_TERMS },
  { id: "gta", cue: /\b(GTA|grand theft auto|leonida|vice city|rockstar)\b/i, terms: GTA_TERMS },
];

const MAX_TERMS = 80;
/** OpenAI reads only the last 224 tokens of a prompt: about this many characters. */
const MAX_PROMPT_CHARS = 600;

/** Names in a text: @handles, #tags, tickers (NQ, SPY) and mixed-case names (IShowSpeed). */
function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[@#]([\p{L}\p{N}_]{2,30})/gu)) out.push(m[1]!);
  for (const m of text.replace(/[@#][\p{L}\p{N}_]+/gu, " ").matchAll(/(?<![\p{L}\p{N}])([\p{Lu}][\p{L}\p{N}]*[\p{Lu}][\p{L}\p{N}]*)(?![\p{L}\p{N}])/gu)) {
    if (m[1]!.length >= 2 && m[1]!.length <= 20) out.push(m[1]!);
  }
  return out;
}

/** Seeds the glossary from what is known about the source: its name, its video titles, its campaign brief. */
export function seedGlossary(o: { creatorName: string; texts: string[]; extra?: string[] }): Glossary {
  const all = [o.creatorName, ...o.texts].join("\n");
  const domains = DOMAINS.filter((d) => d.cue.test(all));
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (t: string) => {
    const term = t.trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key) || terms.length >= MAX_TERMS) return;
    seen.add(key);
    terms.push(term);
  };
  add(o.creatorName);
  (o.extra ?? []).forEach(add);
  o.texts.flatMap(namesIn).forEach(add);
  domains.flatMap((d) => d.terms).forEach(add);
  return { terms, domains: domains.map((d) => d.id) };
}

/** The glossary as a speech-to-text prompt: "TJR, market, futures, …" within its length limit. */
export function sttPrompt(g: Glossary): string {
  let out = "";
  for (const t of g.terms) {
    const next = out ? `${out}, ${t}` : t;
    if (next.length + 1 > MAX_PROMPT_CHARS) break;
    out = next;
  }
  return out ? `${out}.` : "";
}
