const MAX_REDIRECTS = 5;

export class UnsafePublicUrlError extends Error {
  constructor(message = "URL target is not allowed") {
    super(message);
    this.name = "UnsafePublicUrlError";
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  if (host === "::" || host === "::1") return true;
  if (/^(?:fc|fd)/.test(host) || /^fe[89ab]/.test(host)) return true;
  const mappedIpv4 = host.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false;
}

/** Validate user-controlled fetch targets before every network hop. */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafePublicUrlError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafePublicUrlError("Only public http(s) URLs are supported");
  }
  if (url.username || url.password) throw new UnsafePublicUrlError();

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname
      || hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname.endsWith(".internal")
      || isPrivateIpv4(hostname)
      || isPrivateIpv6(hostname)) {
    throw new UnsafePublicUrlError();
  }
  return url;
}

export async function fetchPublicHttpUrl(
  raw: string,
  init: RequestInit = {},
): Promise<{ response: Response; finalUrl: string }> {
  let current = assertPublicHttpUrl(raw);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current.href };
    }
    if (redirectCount === MAX_REDIRECTS) throw new UnsafePublicUrlError("Too many redirects");
    const location = response.headers.get("Location");
    if (!location) return { response, finalUrl: current.href };
    current = assertPublicHttpUrl(new URL(location, current).href);
  }
  throw new UnsafePublicUrlError("Too many redirects");
}
