/**
 * Shared Validation and Security Helpers
 */

/**
 * Validates whether a given URL is safe for server-side fetching (SSRF Protection).
 * Blocks internal hostnames, private IPv4/IPv6 networks, cloud metadata endpoints,
 * and dangerous protocols.
 */
export function isSafePublicUrl(urlString: string): boolean {
  if (!urlString || typeof urlString !== "string") return false;

  try {
    const url = new URL(urlString.trim());

    // Only allow http and https protocols
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    const hostname = url.hostname.toLowerCase();

    // In local development or testing, permit localhost/127.0.0.1 for local streams and internal proxies
    const allowLocal = process.env.ALLOW_LOCAL_PROXY === "true" || process.env.NODE_ENV !== "production";

    // Block localhost and loopback names in production
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    ) {
      return allowLocal;
    }

    // Block AWS/GCP/Azure link-local metadata endpoints
    if (hostname === "169.254.169.254" || hostname.startsWith("169.254.")) {
      return false;
    }

    // Check IPv4 private address ranges:
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [_, o1, o2] = ipv4Match.map(Number);
      if (o1 === 10) return false;
      if (o1 === 127) return allowLocal;
      if (o1 === 0) return false;
      if (o1 === 169 && o2 === 254) return false;
      if (o1 === 172 && o2 >= 16 && o2 <= 31) return false;
      if (o1 === 192 && o2 === 168) return false;
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return false;
    }

    // Check IPv6 private/unique-local ranges (fc00::/7, fe80::/10)
    if (hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
