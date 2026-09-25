// Remembers the plaintext of the last event published per address, so an unchanged replaceable
// event is not published again. The runtime publisher can't tell on its own: encrypted content
// differs on every publish because each encryption uses a fresh nonce.

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export class PublishFingerprints {
  private published = new Map<string, string>();

  isUnchanged(key: string, content: unknown): boolean {
    return this.published.get(key) === stableStringify(content);
  }

  record(key: string, content: unknown): void {
    this.published.set(key, stableStringify(content));
  }

  forget(key: string): void {
    this.published.delete(key);
  }
}
