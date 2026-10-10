import { getAniFlowSkipSummary, getAniSkipTimes } from "./aniskip";

export interface SkipTimeInterval {
  start: number;
  end: number;
}

export interface EpisodeSkipTimes {
  intro: SkipTimeInterval | null;
  outro: SkipTimeInterval | null;
  rawIntro?: SkipTimeInterval | null;
  rawOutro?: SkipTimeInterval | null;
  refDuration?: number | null;
  actualDuration?: number | null;
  adapted?: boolean;
  found?: boolean;
}

/**
 * Resolves opening and ending skip timestamps via AniSkip API with intelligent adaptation and caching.
 */
export async function getEpisodeSkipTimes(
  animeId: number | string | null | undefined,
  episodeNumber: number,
  episodeLengthSeconds: number = 0,
  isMalId: boolean = false
): Promise<EpisodeSkipTimes> {
  if (!animeId) {
    return { intro: null, outro: null, found: false };
  }

  try {
    const summary = await getAniFlowSkipSummary({
      animeId,
      episodeNumber,
      actualDuration: episodeLengthSeconds > 0 ? episodeLengthSeconds : undefined,
      isMalId,
    });

    return {
      intro: summary.intro,
      outro: summary.outro,
      rawIntro: summary.rawIntro,
      rawOutro: summary.rawOutro,
      refDuration: summary.refDuration,
      actualDuration: summary.actualDuration,
      adapted: summary.adapted,
      found: summary.found,
    };
  } catch (err: any) {
    console.warn("[getEpisodeSkipTimes] Error:", err?.message || err);
    return { intro: null, outro: null, found: false };
  }
}
