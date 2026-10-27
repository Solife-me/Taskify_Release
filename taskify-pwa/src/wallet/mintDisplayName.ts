/** A readable name for a mint URL. No dependencies, so wallet recovery can use it after the wallet is gone. */
export function capitalizeWords(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function formatMintDisplayName(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, "");
    const hostParts = hostname.split(".").filter(Boolean);
    const hostLabel = hostParts
      .slice(Math.max(0, hostParts.length - 2))
      .map((part) => capitalizeWords(part.replace(/[-_]+/g, " ")))
      .join(" ");
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = pathSegments.length ? decodeURIComponent(pathSegments[pathSegments.length - 1]!) : "";
    if (lastSegment) {
      const formattedSegment = capitalizeWords(lastSegment.replace(/[-_]+/g, " "));
      return `${hostLabel || hostname} • ${formattedSegment}`.trim();
    }
    return hostLabel || hostname || url;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}
