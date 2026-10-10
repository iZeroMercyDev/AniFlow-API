import Hls from "hls.js";

/**
 * A/V sync guard for hls.js playback.
 *
 * Why this exists: when two consecutive fragments overlap in time (upstream
 * splices like intro/ad cards without #EXT-X-DISCONTINUITY, mismatched
 * mirrors, re-tokenized playlists), hls.js on Chrome shifts the *video*
 * samples of the fragment forward to keep the video track contiguous, while
 * the audio track re-aligns to its real PTS. From that point on every
 * contiguous fragment inherits the shift, so the picture lags the sound by
 * the overlap (often several seconds) until the next seek.
 *
 * For muxed fragments both tracks come from the same file, so their remuxed
 * PTS ranges should end within a fraction of a second of each other. When
 * they don't, we flush and re-attach (recoverMediaError), which reloads the
 * current position as a non-contiguous fragment and re-anchors both tracks
 * to their true timestamps.
 */

const DRIFT_THRESHOLD_S = 0.8;
const CONSECUTIVE_HITS_REQUIRED = 2;
const MIN_RESYNC_INTERVAL_MS = 20_000;
const MAX_RESYNCS_PER_SOURCE = 3;

export interface AvSyncGuardOptions {
  onResync?: (driftSeconds: number, attempt: number) => void;
  onGiveUp?: (driftSeconds: number) => void;
}

export function attachAvSyncGuard(
  hls: Hls,
  video: HTMLVideoElement,
  options: AvSyncGuardOptions = {}
): () => void {
  let hits = 0;
  let lastSign = 0;
  let resyncCount = 0;
  let lastResyncAt = 0;
  let gaveUp = false;
  let pendingResume: (() => void) | null = null;

  const resync = (drift: number) => {
    const now = Date.now();
    if (now - lastResyncAt < MIN_RESYNC_INTERVAL_MS) return;
    if (resyncCount >= MAX_RESYNCS_PER_SOURCE) {
      if (!gaveUp) {
        gaveUp = true;
        options.onGiveUp?.(drift);
      }
      return;
    }
    resyncCount++;
    lastResyncAt = now;
    hits = 0;

    const wasPlaying = !video.paused && !video.ended;
    console.warn(
      `[AvSyncGuard] Audio/video drift of ${drift.toFixed(2)}s detected, re-anchoring stream (attempt ${resyncCount}/${MAX_RESYNCS_PER_SOURCE})`
    );
    options.onResync?.(drift, resyncCount);

    try {
      hls.recoverMediaError();
    } catch {
      return;
    }

    if (wasPlaying) {
      if (pendingResume) video.removeEventListener("canplay", pendingResume);
      pendingResume = () => {
        if (pendingResume) video.removeEventListener("canplay", pendingResume);
        pendingResume = null;
        video.play().catch(() => {});
      };
      video.addEventListener("canplay", pendingResume);
    }
  };

  const onFragBuffered = (_: string, data: { frag: any }) => {
    const frag = data?.frag;
    if (!frag || frag.type !== "main") return;
    const es = frag.elementaryStreams || {};
    const a = es.audio;
    const v = es.video;
    // Only muxed fragments carry both tracks from the same source file.
    if (!a || !v || !Number.isFinite(a.endPTS) || !Number.isFinite(v.endPTS)) return;

    const drift = v.endPTS - a.endPTS;
    if (Math.abs(drift) < DRIFT_THRESHOLD_S) {
      hits = 0;
      lastSign = 0;
      return;
    }

    const sign = Math.sign(drift);
    hits = sign === lastSign ? hits + 1 : 1;
    lastSign = sign;
    if (hits >= CONSECUTIVE_HITS_REQUIRED) {
      resync(drift);
    }
  };

  // A new manifest means a new source: start counting from scratch.
  const onManifestLoading = () => {
    hits = 0;
    lastSign = 0;
    resyncCount = 0;
    gaveUp = false;
  };

  hls.on(Hls.Events.FRAG_BUFFERED, onFragBuffered as any);
  hls.on(Hls.Events.MANIFEST_LOADING, onManifestLoading);

  return () => {
    hls.off(Hls.Events.FRAG_BUFFERED, onFragBuffered as any);
    hls.off(Hls.Events.MANIFEST_LOADING, onManifestLoading);
    if (pendingResume) {
      video.removeEventListener("canplay", pendingResume);
      pendingResume = null;
    }
  };
}
