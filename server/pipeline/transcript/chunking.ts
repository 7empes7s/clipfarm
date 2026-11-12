import type { Word } from "../../../shared/types.js";

export interface AudioChunk {
  index: number;
  startSec: number;
  durationSec: number;
}

/**
 * Splits audio into chunks of at most maxChunkSec that overlap by overlapSec, so a word cut at a
 * chunk edge is heard whole in one of the two chunks.
 */
export function planChunks(totalSec: number, maxChunkSec: number, overlapSec: number): AudioChunk[] {
  if (!(totalSec > 0)) return [];
  if (overlapSec < 0 || overlapSec >= maxChunkSec) throw new Error("overlap must be shorter than a chunk");
  const step = maxChunkSec - overlapSec;
  const chunks: AudioChunk[] = [];
  for (let start = 0; ; start += step) {
    const durationSec = Math.min(maxChunkSec, totalSec - start);
    chunks.push({ index: chunks.length, startSec: start, durationSec });
    if (start + durationSec >= totalSec) break;
  }
  return chunks;
}

export interface ChunkWords {
  startSec: number;
  durationSec: number;
  /** Times relative to the start of the chunk. */
  words: Word[];
}

/**
 * Shifts each chunk's word times by its offset and drops duplicates from the overlaps: where two
 * chunks overlap, words starting before the middle of the overlap come from the earlier chunk and
 * the rest from the later one.
 */
export function mergeChunkWords(chunks: ChunkWords[]): Word[] {
  const sorted = [...chunks].sort((a, b) => a.startSec - b.startSec);
  const out: Word[] = [];
  sorted.forEach((chunk, i) => {
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const from = prev ? (chunk.startSec + prev.startSec + prev.durationSec) / 2 : -Infinity;
    const to = next ? (next.startSec + chunk.startSec + chunk.durationSec) / 2 : Infinity;
    for (const w of chunk.words) {
      const startSec = w.startSec + chunk.startSec;
      if (startSec >= from && startSec < to) {
        out.push({ word: w.word, startSec, endSec: w.endSec + chunk.startSec });
      }
    }
  });
  return out;
}
