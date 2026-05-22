export function parseOnOffState(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "1", "enable", "enabled", "yes"].includes(normalized)) return true;
  if (["off", "false", "0", "disable", "disabled", "no"].includes(normalized)) return false;
  return null;
}
