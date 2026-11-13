import type { Clip } from "../../shared/types";
import { LIVE_TARGET_LATENCY_SEC } from "../../shared/types";
import { clock, duration } from "./format";

/** How long after the moment the clip reached the Inbox: "4 min", or "under 1 min". */
export function latencyText(sec: number): string {
  return sec < 60 ? "under 1 min" : duration(sec);
}

/**
 * Marks a clip cut while the stream was still live: where in the stream it starts, and how long
 * after the moment it reached the Inbox (late when over the 15 minute target).
 */
export function LiveTag({ clip, short }: { clip: Clip; short?: boolean }) {
  if (!clip.live) return null;
  const late = clip.live.latencySec > LIVE_TARGET_LATENCY_SEC;
  return (
    <p className="live-line" data-testid="live-tag">
      <span className="live-tag">
        <span className="live-dot" aria-hidden="true" />
        LIVE
      </span>
      <span>
        {clock(clip.live.streamSec)} into the stream
        {!short && (
          <>
            , in the Inbox <span className={late ? "live-late" : undefined}>{latencyText(clip.live.latencySec)}</span> after it happened
          </>
        )}
      </span>
    </p>
  );
}
