import { NextRequest } from "next/server";
import { GET as playGET, OPTIONS as playOPTIONS } from "@/app/api/play/route";

export const dynamic = "force-dynamic";

export { playOPTIONS as OPTIONS };

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  url.searchParams.set("format", "m3u8");
  const forwardRequest = new NextRequest(url.toString(), {
    headers: request.headers,
    method: "GET",
  });
  return playGET(forwardRequest);
}
