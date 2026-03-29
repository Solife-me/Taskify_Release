// Shared constants and helpers for settings sub-components

export const BIBLE_BOARD_ID = "bible-reading";
export const DEBUG_CONSOLE_STORAGE_KEY = "taskify.debugConsole.enabled";
export const VOICE_TEST_INPUT_STORAGE_KEY = "taskify.voice.testInput.enabled";
export const BOARD_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HISTORY_MARK_SPENT_CUTOFF_MS = 5 * 24 * 60 * 60 * 1000;

export const WD_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function isSameLocalDate(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Returns the first Unicode codepoint (handles emoji and multi-byte chars). */
function firstCodepoint(str: string): string {
  return [...str][0] ?? "";
}

/** True when a string starts with an emoji character. */
function startsWithEmoji(str: string): boolean {
  const cp = str.codePointAt(0);
  if (cp === undefined) return false;
  // Emoji ranges: Misc Symbols, Dingbats, Supplemental Symbols, Emoticons, etc.
  return (
    (cp >= 0x2600 && cp <= 0x27bf) ||  // Misc symbols + dingbats
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji block (emoticons, transport, etc.)
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // Supplemental symbols
    (cp >= 0x2700 && cp <= 0x27bf) ||   // Dingbats
    (cp >= 0xfe00 && cp <= 0xfe0f) ||   // Variation selectors
    cp === 0x200d                         // ZWJ
  );
}

export function contactInitials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = firstCodepoint(parts[0]);
  // If the display name starts with an emoji, use it as the avatar glyph
  if (startsWithEmoji(parts[0])) return first;
  if (parts.length === 1) {
    const chars = [...parts[0]];
    return chars.slice(0, 2).join("").toUpperCase();
  }
  const last = firstCodepoint(parts[parts.length - 1]);
  return (first + last).toUpperCase();
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function pillButtonClass(active: boolean): string {
  return `${active ? "accent-button" : "ghost-button"} pressable`;
}

export function parseCsv(csv: string): string[] {
  return csv.split(",").map(s => s.trim()).filter(Boolean);
}

export function addRelayToCsv(csv: string, relay: string): string {
  const list = parseCsv(csv);
  const val = relay.trim();
  if (!val) return csv;
  if (list.includes(val)) return csv;
  return [...list, val].join(",");
}

export function removeRelayFromCsv(csv: string, relay: string): string {
  const list = parseCsv(csv);
  return list.filter(r => r !== relay).join(",");
}
