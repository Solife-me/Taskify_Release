// Shared constants and helpers for settings sub-components

export { BIBLE_BOARD_ID } from "taskify-core";
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



export { contactInitials } from "taskify-core";

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
