import axios, { AxiosRequestConfig } from "axios";
import { safeFetch, BROWSER_USER_AGENT } from "./fetch-client";
import { getAxiosProxyConfig, isUpstreamProxyConfigured } from "./proxy-agent";

export interface AniSkipInterval {
  startTime: number;
  endTime: number;
}

export type AniSkipType = "op" | "ed" | "mixed-op" | "mixed-ed" | "recap";

export interface AniSkipResultItem {
  interval: AniSkipInterval;
  skipType: AniSkipType | string;
  skipId: string;
  episodeLength: number;
}

export interface AniSkipResponse {
  found: boolean;
  results: AniSkipResultItem[];
  message: string;
  statusCode: number;
  meta?: {
    animeId: number | string; // AniList ID (by default)
    anilistId?: number;
    malId: number;
    episodeNumber: number;
    actualDuration?: number;
    refDuration?: number;
    adapted: boolean;
    proxyUsed?: boolean;
    cached?: boolean;
    source?: "aniskip" | "cache";
  };
}

export interface AniFlowSkipSummary {
  intro: { start: number; end: number } | null;
  outro: { start: number; end: number } | null;
  rawIntro: { start: number; end: number } | null;
  rawOutro: { start: number; end: number } | null;
  refDuration: number | null;
  actualDuration: number | null;
  adapted: boolean;
  found: boolean;
}

// In-memory cache for AniSkip responses: malId:episodeNumber -> { timestamp, data }
interface CacheEntry {
  timestamp: number;
  data: {
    found: boolean;
    results: AniSkipResultItem[];
    statusCode: number;
    message: string;
  };
}

const SKIP_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-memory cache for AniList ID -> MAL ID
const ANILIST_TO_MAL_CACHE = new Map<number, number>();

/**
 * Resolves an AniList ID (anime_id) to its corresponding MyAnimeList ID (mal_id).
 */
export async function resolveAnilistToMalId(animeId: number | string): Promise<number | null> {
  const anilistId = Number(animeId);
  if (isNaN(anilistId) || anilistId <= 0) return null;

  // 1. Check local memory cache
  if (ANILIST_TO_MAL_CACHE.has(anilistId)) {
    return ANILIST_TO_MAL_CACHE.get(anilistId)!;
  }

  // 2. Query AniZip mappings API (fast, lightweight, highly accurate)
  try {
    const azRes = await safeFetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, {
      timeoutMs: 3500,
    });
    if (azRes.ok) {
      const azData = await azRes.json();
      const malId = azData.mappings?.mal_id || azData.mappings?.malId;
      if (malId && Number(malId) > 0) {
        const resolvedMal = Number(malId);
        ANILIST_TO_MAL_CACHE.set(anilistId, resolvedMal);
        return resolvedMal;
      }
    }
  } catch {}

  // 3. Fallback to direct AniList GraphQL query
  try {
    const gql = "query ($id: Int) { Media(id: $id, type: ANIME) { id idMal } }";
    const gqlRes = await safeFetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables: { id: anilistId } }),
      timeoutMs: 3500,
    });
    if (gqlRes.ok) {
      const gqlData = await gqlRes.json();
      const malId = gqlData.data?.Media?.idMal;
      if (malId && Number(malId) > 0) {
        const resolvedMal = Number(malId);
        ANILIST_TO_MAL_CACHE.set(anilistId, resolvedMal);
        return resolvedMal;
      }
    }
  } catch {}

  // 4. Default fallback: use the provided id (e.g. if already a MAL ID)
  return anilistId;
}

/**
 * Query official api.aniskip.com with timeout, proxy fallback, and caching.
 */
export async function fetchAniSkipFromUpstream(
  malId: number,
  episodeNumber: number,
  episodeLength = 0,
  types: string[] = ["op", "ed", "mixed-op", "mixed-ed", "recap"],
  customProxyUrl?: string
): Promise<{
  found: boolean;
  results: AniSkipResultItem[];
  statusCode: number;
  message: string;
  proxyUsed: boolean;
  cached: boolean;
}> {
  const cacheKey = `${malId}:${episodeNumber}:${Math.round(episodeLength)}`;
  const cached = SKIP_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return {
      ...cached.data,
      proxyUsed: false,
      cached: true,
    };
  }

  const typesQuery = types.map((t) => `types=${encodeURIComponent(t)}`).join("&");
  const upstreamUrl = `https://api.aniskip.com/v2/skip-times/${malId}/${episodeNumber}?${typesQuery}&episodeLength=${Math.round(episodeLength)}`;

  let proxyUsed = false;

  // Function to perform the HTTP request
  const doFetch = async (useProxy: boolean) => {
    const reqHeaders = {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    };

    const axiosOptions: AxiosRequestConfig = {
      headers: reqHeaders,
      timeout: 8000,
      validateStatus: () => true, // Don't throw on 404
    };

    if (useProxy) {
      if (customProxyUrl) {
        try {
          const parsed = new URL(customProxyUrl);
          axiosOptions.proxy = {
            protocol: parsed.protocol.replace(":", ""),
            host: parsed.hostname,
            port: parseInt(parsed.port, 10) || 80,
            auth: parsed.username
              ? { username: parsed.username, password: parsed.password || "" }
              : undefined,
          };
          proxyUsed = true;
        } catch {}
      } else {
        const proxyConfig = getAxiosProxyConfig("SCRAPER_PROXY_URL");
        if (proxyConfig) {
          axiosOptions.proxy = proxyConfig;
          proxyUsed = true;
        }
      }
    }

    return await axios.get(upstreamUrl, axiosOptions);
  };

  let response: any = null;

  // 1. Try direct fetch or configured proxy
  try {
    const defaultProxy = isUpstreamProxyConfigured();
    response = await doFetch(defaultProxy);
  } catch (err: any) {
    // If direct failed and proxy was not used, try proxy fallback
    if (!proxyUsed) {
      try {
        response = await doFetch(true);
      } catch (proxyErr: any) {
        // Last attempt with safeFetch native
        try {
          const sfRes = await safeFetch(upstreamUrl, { timeoutMs: 8000 });
          const sfData = await sfRes.json();
          response = { status: sfRes.status, data: sfData };
        } catch {}
      }
    }
  }

  // 2. If queried with episodeLength > 0 and not found, try fallback with episodeLength = 0
  if ((!response || !response.data || !response.data.found) && episodeLength > 0) {
    try {
      const fallbackUrl = `https://api.aniskip.com/v2/skip-times/${malId}/${episodeNumber}?${typesQuery}&episodeLength=0`;
      const fallbackRes = await axios.get(fallbackUrl, {
        headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" },
        timeout: 6000,
        validateStatus: () => true,
      });
      if (fallbackRes.data?.found) {
        response = fallbackRes;
      }
    } catch {}
  }

  // Process and normalize response
  const isFound = Boolean(response?.data?.found && Array.isArray(response?.data?.results));
  const results: AniSkipResultItem[] = isFound
    ? (response.data.results as any[]).map((r) => ({
        interval: {
          startTime: Number(r.interval?.startTime) || 0,
          endTime: Number(r.interval?.endTime) || 0,
        },
        skipType: r.skipType || "op",
        skipId: r.skipId || "",
        episodeLength: Number(r.episodeLength) || 1440,
      }))
    : [];

  const statusCode = response?.status || (isFound ? 200 : 404);
  const message = response?.data?.message || (isFound ? "Successfully found skip times" : "Skip times not found");

  const finalResult = {
    found: isFound,
    results,
    statusCode,
    message,
  };

  // Cache successful responses or confirmed 404s for 1 hour
  SKIP_CACHE.set(cacheKey, {
    timestamp: Date.now(),
    data: finalResult,
  });

  return {
    ...finalResult,
    proxyUsed,
    cached: false,
  };
}

/**
 * Intelligent Skip Times Adaptation Algorithm.
 *
 * Adapts AniSkip intervals to the actual duration of the episode currently being watched.
 * Ensures intro and outro are always positioned precisely on the video:
 * - Accurately differentiates between start bumpers (e.g. 5-10s distributor logo),
 *   end preview/omake cuts, and framerate speed variations.
 * - Anchors outro relative to the end when preview is absent or duration is shorter.
 * - Protects OP and ED duration integrity (does not stretch song duration unless PAL conversion).
 */
export function adaptSkipIntervals(
  results: AniSkipResultItem[],
  actualDuration?: number | null
): {
  results: AniSkipResultItem[];
  adapted: boolean;
  refDuration: number;
} {
  if (!results || results.length === 0) {
    return { results: [], adapted: false, refDuration: 1440 };
  }

  // Reference duration from AniSkip submission
  const refDuration = Math.round(
    results.find((r) => r.episodeLength && r.episodeLength > 0)?.episodeLength || 1440
  );

  // If no actual duration specified or non-positive, return as-is
  if (!actualDuration || actualDuration <= 0) {
    return {
      results: results.map((r) => ({ ...r })),
      adapted: false,
      refDuration,
    };
  }

  const duration = Math.round(actualDuration * 10) / 10;
  const delta = duration - refDuration;
  const ratio = duration / refDuration;

  // Virtually identical durations (difference <= 2 seconds): keep exact timestamps
  if (Math.abs(delta) <= 2) {
    return {
      results: results.map((r) => ({
        ...r,
        episodeLength: duration,
      })),
      adapted: false,
      refDuration,
    };
  }

  // Detect PAL/NTSC framerate conversion (~4% difference across entire file: 24fps vs 25fps)
  const isPalConversion = (ratio >= 0.955 && ratio <= 0.965) || (ratio >= 1.035 && ratio <= 1.045);

  const adaptedResults: AniSkipResultItem[] = results.map((item) => {
    const rawStart = item.interval.startTime;
    const rawEnd = item.interval.endTime;
    const songDuration = Math.max(1, rawEnd - rawStart);
    const isOutro = item.skipType === "ed" || item.skipType === "mixed-ed";
    const isIntro = item.skipType === "op" || item.skipType === "mixed-op" || item.skipType === "recap";

    // 1. PAL Framerate speedup / slowdown
    if (isPalConversion) {
      const newStart = Math.max(0, Math.round(rawStart * ratio * 100) / 100);
      const newEnd = Math.min(duration, Math.round((newStart + songDuration * ratio) * 100) / 100);
      return {
        ...item,
        interval: { startTime: newStart, endTime: newEnd },
        episodeLength: duration,
      };
    }

    // 2. INTRO ADAPTATION (Preserve exact AniSkip timestamps, clamp to duration)
    if (isIntro) {
      const newStart = Math.max(0, rawStart);
      let newEnd = Math.min(duration, newStart + songDuration);
      if (newEnd > duration) {
        newEnd = duration;
      }

      return {
        ...item,
        interval: {
          startTime: Math.round(newStart * 100) / 100,
          endTime: Math.round(newEnd * 100) / 100,
        },
        episodeLength: duration,
      };
    }

    // 3. OUTRO ADAPTATION (Preserve exact AniSkip timestamps, clamp if video truncated)
    if (isOutro) {
      let newStart = rawStart;
      let newEnd = rawEnd;

      if (rawEnd > duration) {
        newEnd = Math.min(duration - 0.5, duration);
        newStart = Math.max(0, newEnd - songDuration);
      } else {
        newStart = Math.min(duration - songDuration, rawStart);
        newEnd = Math.min(duration, newStart + songDuration);
      }

      return {
        ...item,
        interval: {
          startTime: Math.round(newStart * 100) / 100,
          endTime: Math.round(newEnd * 100) / 100,
        },
        episodeLength: duration,
      };
    }

    // Default passthrough with clamp
    const clampedStart = Math.max(0, Math.min(duration, rawStart));
    const clampedEnd = Math.min(duration, Math.max(clampedStart, rawEnd));
    return {
      ...item,
      interval: {
        startTime: Math.round(clampedStart * 100) / 100,
        endTime: Math.round(clampedEnd * 100) / 100,
      },
      episodeLength: duration,
    };
  });

  return {
    results: adaptedResults,
    adapted: true,
    refDuration,
  };
}

/**
 * Unified AniSkip Skip Times Resolver.
 *
 * Resolves AniList ID (anime_id) -> MAL ID, queries AniSkip API with proxy support,
 * and dynamically adapts timestamps to the actual video duration.
 */
export async function getAniSkipTimes(params: {
  animeId: number | string; // AniList ID (by default)
  episodeNumber: number;
  actualDuration?: number | null; // Episode length in seconds
  types?: string[];
  isMalId?: boolean; // Force treating animeId as MAL ID
  customProxyUrl?: string;
}): Promise<AniSkipResponse> {
  const {
    animeId,
    episodeNumber,
    actualDuration,
    types = ["op", "ed", "mixed-op", "mixed-ed", "recap"],
    isMalId = false,
    customProxyUrl,
  } = params;

  // 1. Resolve to MAL ID
  let malId: number | null = null;
  let anilistId: number | undefined = undefined;

  if (isMalId) {
    malId = Number(animeId);
  } else {
    anilistId = Number(animeId);
    malId = await resolveAnilistToMalId(animeId);
  }

  if (!malId || isNaN(malId) || malId <= 0) {
    return {
      found: false,
      results: [],
      message: `Could not resolve AniList ID ${animeId} to MyAnimeList ID.`,
      statusCode: 404,
      meta: {
        animeId,
        anilistId,
        malId: 0,
        episodeNumber,
        actualDuration: actualDuration || undefined,
        adapted: false,
      },
    };
  }

  // 2. Fetch from upstream AniSkip
  const upstream = await fetchAniSkipFromUpstream(
    malId,
    episodeNumber,
    actualDuration || 0,
    types,
    customProxyUrl
  );

  if (!upstream.found || upstream.results.length === 0) {
    return {
      found: false,
      results: [],
      message: upstream.message,
      statusCode: upstream.statusCode,
      meta: {
        animeId,
        anilistId,
        malId,
        episodeNumber,
        actualDuration: actualDuration || undefined,
        adapted: false,
        proxyUsed: upstream.proxyUsed,
        cached: upstream.cached,
      },
    };
  }

  // 3. Adapt intervals to actual video duration
  const { results: adaptedResults, adapted, refDuration } = adaptSkipIntervals(
    upstream.results,
    actualDuration
  );

  return {
    found: true,
    results: adaptedResults,
    message: "Successfully found and adapted skip times",
    statusCode: 200,
    meta: {
      animeId,
      anilistId,
      malId,
      episodeNumber,
      actualDuration: actualDuration || undefined,
      refDuration,
      adapted,
      proxyUsed: upstream.proxyUsed,
      cached: upstream.cached,
      source: upstream.cached ? "cache" : "aniskip",
    },
  };
}

/**
 * Convenience helper returning AniFlow player-friendly object:
 * { intro: { start, end }, outro: { start, end }, rawIntro, rawOutro, ... }
 */
export async function getAniFlowSkipSummary(params: {
  animeId: number | string;
  episodeNumber: number;
  actualDuration?: number | null;
  isMalId?: boolean;
}): Promise<AniFlowSkipSummary> {
  const res = await getAniSkipTimes(params);

  if (!res.found || !res.results || res.results.length === 0) {
    return {
      intro: null,
      outro: null,
      rawIntro: null,
      rawOutro: null,
      refDuration: null,
      actualDuration: params.actualDuration || null,
      adapted: false,
      found: false,
    };
  }

  const op = res.results.find((r) => r.skipType === "op" || r.skipType === "mixed-op");
  const ed = res.results.find((r) => r.skipType === "ed" || r.skipType === "mixed-ed");

  const intro = op
    ? { start: Math.round(op.interval.startTime), end: Math.round(op.interval.endTime) }
    : null;
  const outro = ed
    ? { start: Math.round(ed.interval.startTime), end: Math.round(ed.interval.endTime) }
    : null;

  return {
    intro,
    outro,
    rawIntro: intro,
    rawOutro: outro,
    refDuration: res.meta?.refDuration || 1440,
    actualDuration: params.actualDuration || null,
    adapted: Boolean(res.meta?.adapted),
    found: true,
  };
}
