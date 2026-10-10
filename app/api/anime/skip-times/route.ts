import { NextRequest, NextResponse } from "next/server";
import { getAniSkipTimes } from "@/lib/aniskip";
import { getReanimeSkipTimes } from "@/lib/reanime";
import { adaptSkipTimes } from "@/lib/skip-times-adapter";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Extract anime ID (AniList ID by default, or MAL ID)
  const animeIdParam =
    searchParams.get("anime_id") ||
    searchParams.get("anilistId") ||
    searchParams.get("anilist_id") ||
    searchParams.get("id");
  const malIdParam = searchParams.get("malId") || searchParams.get("mal_id");
  const title = searchParams.get("title") || searchParams.get("query") || "";

  const episodeNumber = parseInt(
    searchParams.get("episodeNumber") ||
      searchParams.get("episode") ||
      searchParams.get("ep") ||
      "1",
    10
  );

  const durationParam =
    searchParams.get("duration") ||
    searchParams.get("episodeLength") ||
    "0";
  const duration = parseFloat(durationParam) || 0;

  const targetId = animeIdParam || malIdParam;
  const isMalId = Boolean(malIdParam && !animeIdParam);

  const serverParam = (searchParams.get("server") || "").toLowerCase().replace(/[\s_-]/g, "");
  const isExplicitNonFlow =
    serverParam.includes("yuri") ||
    serverParam.includes("yuki") ||
    serverParam.includes("zuri") ||
    serverParam.includes("zuna") ||
    serverParam.includes("buzz") ||
    serverParam.includes("megaplay");

  try {
    // 1. For Flow servers (Flow, Kitty) or default: Check Re:ANIME / FlixCloud first
    if (!isExplicitNonFlow && (animeIdParam || title)) {
      try {
        const reanimeData = await getReanimeSkipTimes({
          anilistId: animeIdParam,
          query: title,
          episode: episodeNumber,
        });

        if (reanimeData && (reanimeData.intro || reanimeData.outro)) {
          const refDuration = reanimeData.refDuration || 1440;
          let effectiveIntro = reanimeData.intro;
          let effectiveOutro = reanimeData.outro;
          let adapted = false;

          if (duration > 0) {
            const adaptedResult = adaptSkipTimes(reanimeData.intro, reanimeData.outro, refDuration, duration);
            effectiveIntro = adaptedResult.intro;
            effectiveOutro = adaptedResult.outro;
            adapted = adaptedResult.adapted;
          }

          return NextResponse.json(
            {
              intro: effectiveIntro,
              outro: effectiveOutro,
              rawIntro: reanimeData.intro,
              rawOutro: reanimeData.outro,
              chapters: reanimeData.chapters || [],
              refDuration,
              actualDuration: duration > 0 ? duration : null,
              adapted,
              found: true,
              source: "flow-reanime",
            },
            {
              headers: {
                ...CORS_HEADERS,
                "Cache-Control": "public, max-age=3600, s-maxage=3600",
              },
            }
          );
        }
      } catch (reErr: any) {
        console.warn("[/api/anime/skip-times] Reanime skip times fallback notice:", reErr?.message || reErr);
      }
    }

    // 2. Official AniSkip API for Non-Flow servers (Yuri, Zuri, Buzz) and Flow fallback
    if (targetId) {
      const skipData = await getAniSkipTimes({
        animeId: targetId,
        episodeNumber,
        actualDuration: duration > 0 ? duration : undefined,
        isMalId,
      });

      if (skipData.found && skipData.results.length > 0) {
        const op = skipData.results.find((r) => r.skipType === "op" || r.skipType === "mixed-op" || r.skipType === "recap");
        const ed = skipData.results.find((r) => r.skipType === "ed" || r.skipType === "mixed-ed");

        const rawIntro = op
          ? { start: Math.round(op.interval.startTime), end: Math.round(op.interval.endTime) }
          : null;
        const rawOutro = ed
          ? { start: Math.round(ed.interval.startTime), end: Math.round(ed.interval.endTime) }
          : null;

        return NextResponse.json(
          {
            intro: rawIntro,
            outro: rawOutro,
            rawIntro,
            rawOutro,
            refDuration: skipData.meta?.refDuration || 1440,
            actualDuration: duration > 0 ? duration : null,
            adapted: false,
            found: true,
            source: "aniskip",
            results: skipData.results,
          },
          {
            headers: {
              ...CORS_HEADERS,
              "Cache-Control": "public, max-age=86400, s-maxage=86400",
            },
          }
        );
      }
    }

    return NextResponse.json(
      {
        intro: null,
        outro: null,
        rawIntro: null,
        rawOutro: null,
        chapters: [],
        refDuration: null,
        actualDuration: duration > 0 ? duration : null,
        adapted: false,
        found: false,
      },
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=3600",
        },
      }
    );
  } catch (error: any) {
    return NextResponse.json(
      { intro: null, outro: null, error: error.message, found: false },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
