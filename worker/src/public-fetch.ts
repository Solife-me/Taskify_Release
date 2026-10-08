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

/** Expands an IPv6 literal (with or without a dotted IPv4 tail) to eight 16-bit groups. */
function ipv6Groups(host: string): number[] | null {
  let text = host;
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = dotted.slice(2, 6).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

// URL parsing rewrites embedded IPv4 in hex (`[::ffff:7f00:1]`), so the address is expanded
// before any range check rather than matched as text.
function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  const g = ipv6Groups(host);
  if (!g) return true; // an IPv6 literal that does not parse is refused, not trusted
  const embeddedIpv4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 6).every((group) => group === 0)) return true; // ::, ::1, IPv4-compatible
  if (g.slice(0, 5).every((group) => group === 0) && g[5] === 0xffff) return isPrivateIpv4(embeddedIpv4); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
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
