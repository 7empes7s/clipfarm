import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Word } from "../../shared/types.js";
import type { ClipsRepo } from "../clips/repo.js";
import type { JobHandler } from "../jobs/queue.js";
import { renderClip } from "../pipeline/rerender/render.js";
import type { SourcesRepo } from "../sources/repo.js";
import { generateSample } from "../tools/ffmpeg.js";

export const DEMO_JOB = "demo-clips";

const MASTER_SEC = 16;

/** Ten demo picks: [start, end] in the master, score, title, hook, why. */
const PICKS: [number, number, number, string, string, string][] = [
  [1, 6, 94, "He actually landed the jump", "WAIT FOR IT", "Loud spike and chat laughing right after the landing."],
  [3, 8, 88, "The getaway car flips twice", "NO WAY 😭", "Big reaction, short setup, ends on the laugh."],
  [6, 11, 81, "Chat called it before he did", "CHAT KNEW", "Fast speech and a clear payoff line."],
  [2, 7, 77, "Worst parking job in Vice City", "HOW?!", "Shouting words and a loudness peak."],
  [8, 13, 72, "He trusts the GPS one more time", "GPS STRIKES AGAIN", "Running joke, clean loop at the end."],
  [0, 5, 69, "The heist goes wrong in 4 seconds", "4 SECONDS", "Quick turn from calm to chaos."],
  [5, 10, 64, "Speedrun of getting arrested", "NEW RECORD", "Funny line with a clear ending."],
  [9, 14, 58, "He forgot the mission again", "AGAIN??", "Steady laugh, weaker opening."],
  [4, 9, 52, "Accidental perfect drift", "CLEAN", "Short gameplay moment with a reaction."],
  [10, 15, 47, "Chat votes, he ignores it", "DEMOCRACY", "Low energy, picked for variety."],
];

const SCRIPT =
  "no way he actually did that chat look at this the car is flying okay okay we are fine this is fine " +
  "nobody saw that right clip it clip it now he is gone again what was that";

/** Fake word timings spread over the master, about three words a second. */
function demoWords(): Word[] {
  const words = SCRIPT.split(" ");
  const step = MASTER_SEC / words.length;
  return words.map((word, i) => ({
    word,
    startSec: Math.round(i * step * 1000) / 1000,
    endSec: Math.round((i + 1) * step * 1000) / 1000,
  }));
}

/**
 * "Load demo clips": two demo creators and ten pending clips cut from generated test patterns (no real
 * media), so the gallery can be tried on an empty database. Runs as a queued job because it uses
 * ffmpeg. Demo campaigns allow no platform, so their clips can be exported but never posted.
 */
export function demoClipsHandler(deps: { sources: SourcesRepo; clips: ClipsRepo; mediaDir: string }): JobHandler {
  return async ({ tmpDir, signal, progress }) => {
    await mkdir(deps.mediaDir, { recursive: true });
    const creators = [
      { name: "Demo Streamer A", pattern: "testsrc2" as const, faceCam: { x: 0.68, y: 0.05, w: 0.28, h: 0.3 } },
      { name: "Demo Streamer B", pattern: "smptehdbars" as const, faceCam: null },
    ];
    const made: string[] = [];
    const saved = new Set<string>();
    try {
      const masters = [];
      for (const c of creators) {
        const source = deps.sources.create({
          creatorName: c.name,
          channelUrls: [],
          bannedContent: "Demo data: generated test patterns",
          permission: {
            kind: "direct-permission",
            briefRules: "Demo only. Nothing from this creator can be posted.",
            allowedPlatforms: [],
          },
        });
        if (c.faceCam) deps.sources.setFaceCam(source.id, c.faceCam);
        const masterPath = join(deps.mediaDir, `demo-master-${source.id}.mp4`);
        made.push(masterPath);
        await generateSample(masterPath, MASTER_SEC, signal, "1280x720", c.pattern);
        masters.push({ source, masterPath, faceCam: c.faceCam });
      }
      const words = demoWords();
      for (const [i, [startSec, endSec, score, title, hook, reason]] of PICKS.entries()) {
        progress(0.1 + (0.9 * i) / PICKS.length, `Making demo clip ${i + 1} of ${PICKS.length}`);
        const m = masters[i % masters.length]!;
        const layout = m.faceCam ? ("stacked" as const) : ("center" as const);
        const filePath = join(deps.mediaDir, `demo-clip-${m.source.id}-${i}.mp4`);
        made.push(filePath);
        const input = { clipId: 0, sourceId: m.source.id, masterPath: m.masterPath, startSec, endSec, layout, hook, captionWords: words };
        const durationSec = await renderClip({ ...input, faceCam: m.faceCam }, filePath, tmpDir, signal);
        deps.clips.create({
          sourceId: m.source.id,
          vodId: null,
          title,
          hook,
          reason,
          score,
          layout,
          filePath,
          durationSec,
          captionWords: words,
          masterPath: m.masterPath,
          masterDurationSec: MASTER_SEC,
          startSec,
          endSec,
        });
        saved.add(filePath).add(m.masterPath);
      }
    } catch (err) {
      // Clips already saved keep their files; files no clip points to are removed.
      for (const f of made) if (!saved.has(f)) await rm(f, { force: true });
      throw err;
    }
  };
}
