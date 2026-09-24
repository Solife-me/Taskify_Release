// Picks created_at for outgoing events. Successive versions of one replaceable address need
// strictly increasing timestamps (with equal ones a relay may keep the older version), so those
// are bumped past the last one. Nothing else is: bumping every event from a signer pushed a
// burst of changes to different tasks ahead of real time, and relays reject events too far in
// the future (strfry: 15 minutes).

/** How far ahead of the clock an event may be stamped. */
export const MAX_CREATED_AT_LEAD_SECONDS = 60;

type TimestampedTemplate = { kind: number; tags: string[][] };

function replaceableAddress(signer: string, template: TimestampedTemplate): string | null {
  const { kind } = template;
  const parameterized = kind >= 30000 && kind < 40000;
  const replaceable = kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
  if (!parameterized && !replaceable) return null;
  const d = parameterized ? template.tags.find((tag) => tag[0] === "d")?.[1] ?? "" : "";
  return `${signer}:${kind}:${d}`;
}

export class EventTimestampClock {
  private lastByAddress = new Map<string, number>();

  next(signer: string, template: TimestampedTemplate, requested: number, nowSeconds: number): number {
    const ceiling = nowSeconds + MAX_CREATED_AT_LEAD_SECONDS;
    const address = replaceableAddress(signer, template);
    if (!address) return Math.min(requested, ceiling);
    const last = this.lastByAddress.get(address) ?? 0;
    const createdAt = Math.min(Math.max(requested, last + 1), ceiling);
    this.lastByAddress.set(address, createdAt);
    return createdAt;
  }
}
