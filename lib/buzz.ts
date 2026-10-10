import crypto from "crypto";
import { safeFetch } from "./fetch-client";

function padBuffer(str: string, len: number): Buffer {
  const enc = Buffer.from(str, "utf8");
  const buf = Buffer.alloc(len, 0);
  enc.copy(buf, 0, 0, Math.min(len, enc.length));
  return buf;
}

export function decryptBuzzEnc(encStr: string): { file: string } | null {
  try {
    const key = padBuffer("i?LMTAx0Q6,:}50U", 32);
    const iv = padBuffer("W0;27ToaUpl_P%'c", 16);

    let b64 = encStr.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const ciphertext = Buffer.from(b64, "base64");

    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch (err: any) {
    console.warn("[decryptBuzzEnc] Error:", err?.message || err);
    return null;
  }
}

export interface BuzzStreamResult {
  m3u8: string;
  rawM3u8: string;
  subtitles: Array<{
    language: string;
    label: string;
    subtitleUrl: string;
    isDefault?: boolean;
  }>;
  intro: { start: number; end: number } | null;
  outro: { start: number; end: number } | null;
}

const buzzCache = new Map<string, { data: BuzzStreamResult | null; timestamp: number }>();
const BUZZ_CACHE_TTL = 30 * 60 * 1000;

function unwrapPayload(json: any): any {
  let payload = json;
  for (const key of ["data", "result", "stream_data", "streamData"]) {
    if (payload && typeof payload === "object" && payload[key] && typeof payload[key] === "object") {
      payload = payload[key];
    }
  }
  return payload;
}

function parseSourcesPayload(sourcesData: any): BuzzStreamResult | null {
  if (!sourcesData || typeof sourcesData !== "object") return null;

  let rawM3u8 = "";
  if (sourcesData.enc) {
    const decrypted = decryptBuzzEnc(sourcesData.enc);
    if (decrypted?.file) rawM3u8 = decrypted.file;
  }

  if (!rawM3u8) {
    const rawSources = sourcesData.sources ?? sourcesData.source ?? sourcesData.streams ?? sourcesData.file;
    const candidates = Array.isArray(rawSources) ? rawSources : rawSources ? [rawSources] : [];
    for (const c of candidates) {
      const u = typeof c === "string" ? c.trim() : (c?.file || c?.url || c?.src || c?.link || "");
      if (u && (u.includes(".m3u8") || u.includes("m3u8"))) {
        rawM3u8 = u;
        break;
      }
    }
  }

  if (!rawM3u8) return null;

  const proxyM3u8 = `/api/proxy/m3u8?url=${encodeURIComponent(rawM3u8)}&referer=${encodeURIComponent("https://megaplay.buzz/")}`;

  const rawTracks = sourcesData.tracks ?? sourcesData.subtitles ?? sourcesData.subs ?? sourcesData.captions ?? [];
  const subtitles = (Array.isArray(rawTracks) ? rawTracks : [])
    .map((t: any, idx: number) => {
      const fileUrl = t.file || t.url || t.src || t.link || "";
      const proxySubUrl = fileUrl
        ? (fileUrl.startsWith("/api/proxy") ? fileUrl : `/api/proxy/subtitles?url=${encodeURIComponent(fileUrl)}&referer=${encodeURIComponent("https://megaplay.buzz/")}`)
        : "";
      return {
        language: t.label || t.language || t.lang || "English",
        label: t.label || t.language || t.lang || "English",
        subtitleUrl: proxySubUrl,
        isDefault: t.default !== undefined ? Boolean(t.default) : idx === 0,
      };
    })
    .filter((s: any) => Boolean(s.subtitleUrl));

  const intro =
    sourcesData.intro?.start !== undefined &&
    sourcesData.intro?.end !== undefined &&
    sourcesData.intro.end > sourcesData.intro.start
      ? { start: Math.round(sourcesData.intro.start), end: Math.round(sourcesData.intro.end) }
      : null;

  const outro =
    sourcesData.outro?.start !== undefined &&
    sourcesData.outro?.end !== undefined &&
    sourcesData.outro.end > sourcesData.outro.start
      ? { start: Math.round(sourcesData.outro.start), end: Math.round(sourcesData.outro.end) }
      : null;

  return {
    m3u8: proxyM3u8,
    rawM3u8,
    subtitles,
    intro,
    outro,
  };
}

export async function resolveBuzzStream(params: {
  anilistId?: number | null;
  malId?: number | null;
  episode: number;
  type?: "sub" | "dub";
}): Promise<BuzzStreamResult | null> {
  const { anilistId, malId, episode, type = "sub" } = params;
  if (!anilistId && !malId) return null;

  const cacheKey = `${anilistId || ""}_${malId || ""}_${episode}_${type}`;
  const cached = buzzCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < BUZZ_CACHE_TTL) {
    return cached.data;
  }

  try {
    // 1. Method A: Stream HTML player page -> getSources?id=dataId
    const streamPageUrl = anilistId
      ? `https://megaplay.buzz/stream/ani/${anilistId}/${episode}/${type}`
      : `https://megaplay.buzz/stream/mal/${malId}/${episode}/${type}`;

    const pageRes = await safeFetch(streamPageUrl, {
      headers: {
        Referer: "https://megaplay.buzz/api",
      },
      timeoutMs: 6000,
    });

    if (pageRes.ok) {
      const html = await pageRes.text();
      const dataIdMatch =
        html.match(/id="megaplay-player"[^>]*data-id="(\d+)"/) ||
        html.match(/data-id="(\d+)"/);

      if (dataIdMatch && dataIdMatch[1]) {
        const dataId = dataIdMatch[1];
        const getSourcesUrl = `https://megaplay.buzz/stream/getSources?id=${dataId}`;

        const sourcesRes = await safeFetch(getSourcesUrl, {
          headers: {
            Referer: streamPageUrl,
            "X-Requested-With": "XMLHttpRequest",
          },
          timeoutMs: 6000,
        });

        if (sourcesRes.ok) {
          const sourcesData = await sourcesRes.json();
          const parsed = parseSourcesPayload(sourcesData);
          if (parsed) {
            buzzCache.set(cacheKey, { data: parsed, timestamp: Date.now() });
            return parsed;
          }
        }
      }
    }

    // 2. Method B: Direct API probing (tested fallback patterns from Megaplay API)
    const apiTemplates = [
      anilistId ? `https://megaplay.buzz/api/stream/${anilistId}/${episode}/${type}` : null,
      anilistId ? `https://megaplay.buzz/api/sources?id=${anilistId}&ep=${episode}&type=${type}` : null,
      anilistId ? `https://megaplay.buzz/api/episode?anilist=${anilistId}&ep=${episode}&audio=${type}` : null,
      malId ? `https://megaplay.buzz/api/stream/mal/${malId}/${episode}/${type}` : null,
    ].filter(Boolean) as string[];

    for (const apiUrl of apiTemplates) {
      try {
        const apiRes = await safeFetch(apiUrl, {
          headers: {
            Referer: "https://megaplay.buzz/",
            Origin: "https://megaplay.buzz",
            "X-Requested-With": "XMLHttpRequest",
          },
          timeoutMs: 5000,
        });
        if (!apiRes.ok) continue;
        const json = await apiRes.json();
        const payload = unwrapPayload(json);
        const parsed = parseSourcesPayload(payload);
        if (parsed) {
          buzzCache.set(cacheKey, { data: parsed, timestamp: Date.now() });
          return parsed;
        }
      } catch {}
    }

    buzzCache.set(cacheKey, { data: null, timestamp: Date.now() });
    return null;
  } catch (err: any) {
    console.warn("[resolveBuzzStream] Error:", err?.message || err);
    return null;
  }
}
