export type TimestampedRelayEvent = {
  created_at?: number;
};

export function relayEventCreatedAt(event: TimestampedRelayEvent): number {
  return typeof event.created_at === "number" && Number.isFinite(event.created_at)
    ? event.created_at
    : 0;
}

export function pickLatestEvent<TEvent extends TimestampedRelayEvent>(
  events: Iterable<TEvent>,
): TEvent | null {
  let latest: TEvent | null = null;
  for (const event of events) {
    if (!latest || relayEventCreatedAt(event) >= relayEventCreatedAt(latest)) {
      latest = event;
    }
  }
  return latest;
}

export async function pickLatestParsedEvent<TEvent extends TimestampedRelayEvent, TParsed>(
  events: Iterable<TEvent>,
  parseEvent: (event: TEvent) => Promise<TParsed | null>,
): Promise<{ event: TEvent; parsed: TParsed } | null> {
  let latest: { event: TEvent; parsed: TParsed } | null = null;
  for (const event of events) {
    const parsed = await parseEvent(event);
    if (!parsed) continue;
    if (!latest || relayEventCreatedAt(event) >= relayEventCreatedAt(latest.event)) {
      latest = { event, parsed };
    }
  }
  return latest;
}
