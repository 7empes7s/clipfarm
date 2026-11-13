import { AccountStatsStore } from "./accounts/stats.js";
import { ClipsRepo } from "./clips/repo.js";
import { type Config, loadConfig, openSettings } from "./config.js";
import { type Db, openDb } from "./db/index.js";
import { DEMO_JOB, demoClipsHandler } from "./dev/demo.js";
import { DEMO_DATA_JOB, demoDataHandler } from "./dev/demoData.js";
import { ENGINE_SETUP_JOB } from "./engine/engine.js";
import { engineSetupHandler } from "./engine/setup.js";
import { JobQueue } from "./jobs/queue.js";
import { PicksRepo } from "./picks/repo.js";
import { pipelineOnFinished } from "./pipeline/chain.js";
import { INGEST_JOB, ingestHandler } from "./pipeline/ingest/ingest.js";
import { PICKS_JOB, picksHandler } from "./pipeline/picks/job.js";
import { RENDER_JOB, renderHandler } from "./pipeline/render/job.js";
import { onRenderFinished, RENDER_CLIP_JOB, renderClipHandler } from "./pipeline/rerender/render.js";
import { Publisher } from "./publish/publisher.js";
import { PostsRepo } from "./publish/repo.js";
import type { Settings } from "./settings/store.js";
import { SourcesRepo } from "./sources/repo.js";
import { VodsRepo } from "./vods/repo.js";

export interface Runtime {
  settings: Settings;
  config: Config;
  db: Db;
  sources: SourcesRepo;
  vods: VodsRepo;
  picks: PicksRepo;
  clips: ClipsRepo;
  posts: PostsRepo;
  publisher: Publisher;
  accountStats: AccountStatsStore;
  queue: JobQueue;
}

/**
 * The database, the keys and the job queue with every pipeline step, built from the environment.
 * The server and the ops CLI both start from this, so a job means the same thing in either.
 */
export function openRuntime(env: NodeJS.ProcessEnv = process.env, opts: { pollMs?: number } = {}): Runtime {
  const settings = openSettings(env);
  const config = loadConfig(env, settings);
  const db = openDb(config.dbFile);
  config.engine.bind(db);
  const sources = new SourcesRepo(db);
  const vods = new VodsRepo(db);
  const picks = new PicksRepo(db);
  const clips = new ClipsRepo(db);
  const posts = new PostsRepo(db);
  const publisher = new Publisher({ sources, clips, posts, service: config.postingService, vodTitle: (id) => vods.get(id).title });
  const accountStats = new AccountStatsStore(db, config.postingService, posts, { accounts: publisher.accounts });
  const mediaDir = config.mediaDir;
  const pipelineFinished = pipelineOnFinished({ vods, picks, queue: () => queue });
  const clipRenderFinished = onRenderFinished(clips);
  const queue: JobQueue = new JobQueue(db, {
    handlers: {
      [INGEST_JOB]: ingestHandler({ sources, vods, downloader: config.downloader, transcriber: config.transcriber }),
      [PICKS_JOB]: picksHandler({ sources, vods, picks, picker: config.picker, maxPicks: config.maxPicks }),
      [RENDER_JOB]: renderHandler({
        sources,
        vods,
        picks,
        clips,
        downloader: config.sectionDownloader,
        mediaDir,
        preset: config.renderPreset,
      }),
      [RENDER_CLIP_JOB]: renderClipHandler({ clips, sources, mediaDir }),
      [ENGINE_SETUP_JOB]: engineSetupHandler(config.engine),
      [DEMO_JOB]: demoClipsHandler({ sources, clips, mediaDir }),
      [DEMO_DATA_JOB]: demoDataHandler({ db, sources, clips, vods, accountStats, mediaDir }),
    },
    onFinished: (job, payload) => {
      pipelineFinished(job, payload);
      clipRenderFinished(job);
    },
    pollMs: opts.pollMs,
  });
  return { settings, config, db, sources, vods, picks, clips, posts, publisher, accountStats, queue };
}
