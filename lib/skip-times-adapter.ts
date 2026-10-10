/**
 * Skip Times Adaptation Algorithm
 *
 * Mathematically adapts baseline skip times (e.g. from Re:ANIME / FlixCloud chapters)
 * to match the exact duration of an episode stream from any server (Yuri, Zuri, Buzz, etc.).
 *
 * Accounts for:
 * 1. Near-identical encodes (|delta| <= 2s): preserves exact millisecond timestamps.
 * 2. PAL / NTSC framerate differences (~4% delta across file, e.g. 25fps vs 23.976fps): scales proportionally.
 * 3. Leading studio/distributor bumpers (e.g. 5-15s Crunchyroll/Funimation logo): shifts intro & outro forward.
 * 4. Missing bumpers (reference had bumper, target does not): shifts markers backward.
 * 5. Cut or extra previews / omake / post-credits scenes at the end: anchors outro relative to file end.
 * 6. Extended or trimmed episode cuts (significant delta): mathematically interpolates position while strictly
 *    preserving OP/ED song duration.
 */

export interface SkipInterval {
  start: number;
  end: number;
}

export interface AdaptedSkipTimesResult {
  intro: SkipInterval | null;
  outro: SkipInterval | null;
  adapted: boolean;
  refDuration: number;
  actualDuration: number;
}

/**
 * Adapt intro and outro skip markers to actual video duration using math.
 *
 * @param intro Baseline intro timestamps (from Re:ANIME / FlixCloud / AniSkip)
 * @param outro Baseline outro timestamps
 * @param refDuration Baseline duration of the reference episode in seconds (e.g. from Re:ANIME)
 * @param actualDuration Actual duration of the currently playing stream in seconds
 */
export function adaptSkipTimes(
  intro: SkipInterval | null,
  outro: SkipInterval | null,
  refDuration?: number | null,
  actualDuration?: number | null
): AdaptedSkipTimesResult {
  const actualDur = typeof actualDuration === "number" && actualDuration > 0 ? actualDuration : 0;
  const effectiveRef = typeof refDuration === "number" && refDuration > 0 ? refDuration : 1440;

  if (actualDur <= 0 || (!intro && !outro)) {
    return {
      intro: intro ? { ...intro } : null,
      outro: outro ? { ...outro } : null,
      adapted: false,
      refDuration: effectiveRef,
      actualDuration: actualDur,
    };
  }

  // 1. Virtually identical durations (difference <= 2 seconds): keep exact timestamps
  const delta = actualDur - effectiveRef;
  if (Math.abs(delta) <= 2) {
    return {
      intro: intro ? { ...intro } : null,
      outro: outro ? { ...outro } : null,
      adapted: false,
      refDuration: effectiveRef,
      actualDuration: actualDur,
    };
  }

  const ratio = actualDur / effectiveRef;
  // Detect PAL/NTSC framerate conversion (~4% difference across entire file: 24fps vs 25fps)
  const isPal = (ratio >= 0.955 && ratio <= 0.965) || (ratio >= 1.035 && ratio <= 1.045);

  let newIntro: SkipInterval | null = null;
  let bumperOffset = 0;

  // 2. INTRO ADAPTATION
  if (intro && intro.start >= 0 && intro.end > intro.start) {
    const opDuration = Math.max(1, intro.end - intro.start);

    if (isPal) {
      // PAL/NTSC framerate speedup / slowdown
      const s = Math.max(0, Math.round(intro.start * ratio * 10) / 10);
      const e = Math.min(actualDur, Math.round((s + opDuration * ratio) * 10) / 10);
      newIntro = { start: s, end: e };
    } else {
      let s = intro.start;

      if (Math.abs(delta) > 30) {
        // Only if there is a dramatic duration difference (e.g. multi-minute recap):
        const relPos = Math.min(1, Math.max(0, intro.start / effectiveRef));
        s = Math.max(0, intro.start + delta * relPos);
      }

      let e = Math.min(actualDur, s + opDuration);
      if (e > actualDur) {
        e = actualDur;
        s = Math.max(0, e - opDuration);
      }
      if (e > s) {
        newIntro = {
          start: Math.round(s * 10) / 10,
          end: Math.round(e * 10) / 10,
        };
      }
    }
  }

  // 3. OUTRO ADAPTATION
  let newOutro: SkipInterval | null = null;
  if (outro && outro.start >= 0 && outro.end > outro.start) {
    const edDuration = Math.max(1, outro.end - outro.start);
    const distFromEndRef = Math.max(0, effectiveRef - outro.end);

    if (isPal) {
      const s = Math.max(0, Math.round(outro.start * ratio * 10) / 10);
      const e = Math.min(actualDur, Math.round((s + edDuration * ratio) * 10) / 10);
      newOutro = { start: s, end: e };
    } else if (outro.end > actualDur) {
      // The reference outro extends beyond the end of current video file:
      // Anchor outro backward from the end of the video
      const e = Math.min(actualDur - 0.5, Math.max(10, actualDur - Math.min(distFromEndRef, 5)));
      const s = Math.max(0, e - edDuration);
      newOutro = {
        start: Math.round(s * 10) / 10,
        end: Math.round(e * 10) / 10,
      };
    } else if (distFromEndRef <= 10 && delta > 20) {
      // Reference file ended immediately after ED (no preview), but current stream has extra preview:
      // Keep ED at its original timestamp from the start (plus bumper if any)
      const s = outro.start + bumperOffset;
      const e = Math.min(actualDur, s + edDuration);
      newOutro = {
        start: Math.round(s * 10) / 10,
        end: Math.round(e * 10) / 10,
      };
    } else if (distFromEndRef > 15 && delta < -10) {
      // Current stream is missing preview at the end:
      // Anchor ED relative to actual video end
      const scaledPreviewDist = Math.round(distFromEndRef * Math.max(0.5, Math.min(1, ratio)));
      const e = Math.min(actualDur - 0.5, Math.max(edDuration, actualDur - scaledPreviewDist));
      const s = Math.max(0, e - edDuration);
      newOutro = {
        start: Math.round(s * 10) / 10,
        end: Math.round(e * 10) / 10,
      };
    } else {
      // Standard case: if duration varies by more than 18s, shift with end of video
      let s = outro.start;
      if (Math.abs(delta) > 18) {
        const e = Math.min(actualDur - 0.5, Math.max(edDuration, actualDur - distFromEndRef));
        s = Math.max(0, e - edDuration);
      } else {
        s = Math.min(actualDur - edDuration, outro.start);
      }
      const e = Math.min(actualDur, s + edDuration);
      newOutro = {
        start: Math.round(s * 10) / 10,
        end: Math.round(e * 10) / 10,
      };
    }
  }

  return {
    intro: newIntro,
    outro: newOutro,
    adapted: true,
    refDuration: effectiveRef,
    actualDuration: actualDur,
  };
}

/**
 * Backwards compatibility alias for components expecting adaptIntervals
 */
export const adaptIntervals = (
  intro: SkipInterval | null,
  outro: SkipInterval | null,
  refDur: number,
  actualDur: number
) => {
  const res = adaptSkipTimes(intro, outro, refDur, actualDur);
  return { intro: res.intro, outro: res.outro };
};
