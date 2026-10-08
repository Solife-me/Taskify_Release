/**
 * Text other people wrote -- task, event, board, column, contact, and inbox fields -- is printed to
 * the user's terminal. Control characters there could move the cursor, erase or rewrite lines
 * (turning "✗ untrusted" into "✓ trusted"), retitle the terminal, or, where OSC 52 is allowed,
 * replace the clipboard; direction overrides can disguise text. These are removed when remote data
 * is decoded for display. Tab and newline stay; carriage return goes, since it rewrites a line.
 */
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function stripControlCharacters(value: string): string {
  return value.replace(UNSAFE_CHARACTERS, "");
}

/** A copy of `value` with every string, at any depth, passed through `stripControlCharacters`. */
export function sanitizeRemote<T>(value: T): T {
  if (typeof value === "string") return stripControlCharacters(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeRemote(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[stripControlCharacters(key)] = sanitizeRemote(item);
    }
    return out as T;
  }
  return value;
}
