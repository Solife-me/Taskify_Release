export type FileServerType = "nip96" | "blossom" | "originless";

export type FileServerEntry = {
  url: string;
  type: FileServerType;
  label?: string;
};

export const DEFAULT_PUBLIC_FILE_STORAGE_SERVER = "https://nostr.build";
export const DEFAULT_ENCRYPTED_FILE_STORAGE_SERVER = "https://originless.solife.me";
export const DEFAULT_FILE_STORAGE_SERVER = DEFAULT_PUBLIC_FILE_STORAGE_SERVER;

export const DEFAULT_FILE_SERVERS: FileServerEntry[] = [
  { url: "https://nostr.build", type: "nip96", label: "nostr.build" },
  { url: "https://blossom.band", type: "blossom", label: "blossom.band" },
  { url: "https://originless.besoeasy.com", type: "originless", label: "originless.besoeasy.com" },
  { url: "https://originless.solife.me", type: "originless", label: "originless.solife.me" },
];

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.replace(/\/+$/, "") : url;
}

export function normalizeFileServerUrl(value: string | null | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "";

  const tryBuild = (input: string): string | null => {
    try {
      const parsed = new URL(input);
      if (!parsed.protocol || parsed.protocol === ":") return null;
      const base = `${parsed.protocol}//${parsed.host}`;
      const path = parsed.pathname ? trimTrailingSlash(parsed.pathname) : "";
      return `${base}${path}`;
    } catch {
      return null;
    }
  };

  return tryBuild(raw) ?? tryBuild(`https://${raw}`) ?? "";
}

export function inferFileServerType(url: string): FileServerType {
  const normalized = normalizeFileServerUrl(url).toLowerCase();
  if (normalized.includes("originless")) return "originless";
  if (normalized.includes("blossom")) return "blossom";
  return "nip96";
}

export function parseFileServers(raw: string | null | undefined): FileServerEntry[] {
  if (!raw) return DEFAULT_FILE_SERVERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_FILE_SERVERS;
    const normalized = parsed
      .map((entry: any): FileServerEntry | null => {
        const url = normalizeFileServerUrl(entry?.url);
        const type = entry?.type;
        if (!url || (type !== "nip96" && type !== "blossom" && type !== "originless")) return null;
        return { url, type, ...(entry?.label ? { label: String(entry.label) } : {}) };
      })
      .filter(Boolean) as FileServerEntry[];
    return normalized.length ? normalized : DEFAULT_FILE_SERVERS;
  } catch {
    return DEFAULT_FILE_SERVERS;
  }
}

export function serializeFileServers(servers: FileServerEntry[]): string {
  return JSON.stringify(servers.map((entry) => ({ url: normalizeFileServerUrl(entry.url) || entry.url, type: entry.type, ...(entry.label ? { label: entry.label } : {}) })));
}

export function findServerEntry(servers: FileServerEntry[], url: string): FileServerEntry | null {
  const normalized = normalizeFileServerUrl(url) || url;
  return servers.find((entry) => (normalizeFileServerUrl(entry.url) || entry.url) === normalized) || null;
}
