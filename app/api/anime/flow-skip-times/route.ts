import { NextRequest, NextResponse } from "next/server";
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

  const animeIdParam =
    searchParams.get("anilistId") ||
    searchParams.get("anime_id") ||
    searchParams.get("id");
  const title = searchParams.get("title") || searchParams.get("query") || "";
  const episodeNumber = parseInt(
    searchParams.get("episodeNumber") ||
      searchParams.get("episode") ||
      searchParams.get("ep") ||
      "1",
    10
  );
  const aid = searchParams.get("aid") || searchParams.get("accessId");
  const version = parseInt(searchParams.get("v") || searchParams.get("version") || "1", 10);
  const durationParam = searchParams.get("duration") || searchParams.get("episodeLength") || "0";
  const duration = parseFloat(durationParam) || 0;

  try {
    const skipData = await getReanimeSkipTimes({
      anilistId: animeIdParam,
      query: title,
      episode: episodeNumber,
      accessId: aid,
      version,
    });

    const found = Boolean(skipData.intro || skipData.outro);
    const refDuration = skipData.refDuration || 1440;

    let effectiveIntro = skipData.intro;
    let effectiveOutro = skipData.outro;
    let adapted = false;

    if (found && duration > 0) {
      const adaptedResult = adaptSkipTimes(skipData.intro, skipData.outro, refDuration, duration);
      effectiveIntro = adaptedResult.intro;
      effectiveOutro = adaptedResult.outro;
      adapted = adaptedResult.adapted;
    }

    return NextResponse.json(
      {
        success: true,
        found,
        intro: effectiveIntro,
        outro: effectiveOutro,
        rawIntro: skipData.intro,
        rawOutro: skipData.outro,
        chapters: skipData.chapters || [],
        refDuration,
        actualDuration: duration > 0 ? duration : null,
        adapted,
        source: "flow-reanime",
      },
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=3600, s-maxage=3600",
        },
      }
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        success: false,
        found: false,
        intro: null,
        outro: null,
        rawIntro: null,
        rawOutro: null,
        chapters: [],
        refDuration: null,
        actualDuration: duration > 0 ? duration : null,
        adapted: false,
        error: error?.message || "Failed to fetch flow skip times",
      },
      {
        status: 500,
        headers: CORS_HEADERS,
      }
    );
  }
}
