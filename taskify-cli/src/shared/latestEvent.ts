export type TimestampedRelayEvent = {
  created_at?: number;
  id?: string;
};

export function relayEventCreatedAt(event: TimestampedRelayEvent): number {
  return typeof event.created_at === "number" && Number.isFinite(event.created_at)
    ? event.created_at
    : 0;
}

/**
 * Compare replaceable Nostr events using the deterministic ordering from NIP-01.
 * A positive value means `candidate` replaces `current`: a newer timestamp wins,
 * and for equal timestamps the event with the lexicographically lower id wins.
 */
export function compareReplaceableEvents(
  candidate: TimestampedRelayEvent,
  current: TimestampedRelayEvent,
): number {
  const timestampDelta = relayEventCreatedAt(candidate) - relayEventCreatedAt(current);
  if (timestampDelta !== 0) return timestampDelta;

  const candidateId = typeof candidate.id === "string" ? candidate.id : "";
  const currentId = typeof current.id === "string" ? current.id : "";
  if (candidateId === currentId) return 0;
  if (!candidateId) return -1;
  if (!currentId) return 1;
  return candidateId < currentId ? 1 : -1;
}

export function pickLatestEvent<TEvent extends TimestampedRelayEvent>(
  events: Iterable<TEvent>,
): TEvent | null {
  let latest: TEvent | null = null;
  for (const event of events) {
    if (!latest || compareReplaceableEvents(event, latest) > 0) {
      latest = event;
    }
  }
  return latest;
}

export async function pickLatestParsedEvent<TEvent extends TimestampedRelayEvent, TParsed>(
  events: Iterable<TEvent>,
  parseEvent: (event: TEvent) => Promise<TParsed | null>,
): Promise<{ event: TEvent; parsed: TParsed } | null> {
  const newestFirst = Array.from(events).sort((a, b) => compareReplaceableEvents(b, a));
  for (const event of newestFirst) {
    const parsed = await parseEvent(event);
    if (parsed) return { event, parsed };
  }
  return null;
}

/** Select exactly one valid replaceable event for each logical entity key. */
export async function pickLatestParsedEventsByKey<TEvent extends TimestampedRelayEvent, TParsed>(
  events: Iterable<TEvent>,
  keyForEvent: (event: TEvent) => string | null | undefined,
  parseEvent: (event: TEvent) => Promise<TParsed | null>,
): Promise<Map<string, { event: TEvent; parsed: TParsed }>> {
  const candidatesByKey = new Map<string, TEvent[]>();
  for (const event of events) {
    const key = keyForEvent(event)?.trim();
    if (!key) continue;
    const candidates = candidatesByKey.get(key) ?? [];
    candidates.push(event);
    candidatesByKey.set(key, candidates);
  }

  const latestByKey = new Map<string, { event: TEvent; parsed: TParsed }>();
  const groups = Array.from(candidatesByKey.entries());
  let nextGroup = 0;
  const worker = async () => {
    while (nextGroup < groups.length) {
      const [key, candidates] = groups[nextGroup++];
      candidates.sort((a, b) => compareReplaceableEvents(b, a));
      for (const event of candidates) {
        const parsed = await parseEvent(event);
        if (!parsed) continue;
        latestByKey.set(key, { event, parsed });
        break;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, groups.length) }, worker));
  return latestByKey;
}
