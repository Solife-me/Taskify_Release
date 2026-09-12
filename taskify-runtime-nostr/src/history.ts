import type { NDKFilter } from '@nostr-dev-kit/ndk';
import type { NostrEvent } from 'nostr-tools';
import type { ManagedSubscription, SubscribeOptions } from './SubscriptionManager.js';

type HistorySession = {
  subscribe(filters: NDKFilter[], options: SubscribeOptions): Promise<Pick<ManagedSubscription, 'release' | 'filters'>>;
};

/** Read each relay independently; a timeout is not evidence that history is complete. */
export async function recoverRelayHistory(
  session: HistorySession,
  filter: NDKFilter,
  relay: string,
  onEvent: (event: NostrEvent) => Promise<void>,
  options: { signal?: AbortSignal; pageSize?: number; maxPageSize?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pageSize = options.pageSize ?? 200;
  const maxPageSize = options.maxPageSize ?? 5000;
  let limit = pageSize;
  let until = filter.until ?? Math.floor(Date.now() / 1000);
  const since = filter.since ?? 0;
  let boundaryIDs = new Set<string>();
  while (until >= since) {
    options.signal?.throwIfAborted();
    const page = new Map<string, NostrEvent>();
    let release: (() => void) | undefined;
    let effectiveLimit = limit;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let settled = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (error) reject(error); else resolve();
        };
        abort = () => finish(new Error('History recovery cancelled'));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        timer = setTimeout(() => finish(new Error(`History recovery timed out: ${relay}`)), options.timeoutMs ?? 25000);
        void session.subscribe([{ ...filter, since, until, limit }], {
          relayUrls: [relay], skipSince: true,
          onEvent: event => { if (!settled) page.set(event.id, event); },
          onEose: () => finish(),
        }).then(managed => {
          release = () => { release = undefined; managed.release(); };
          effectiveLimit = managed.filters[0]?.limit ?? limit;
          if (settled) release();
        }, finish);
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener('abort', abort);
      release?.();
    }
    options.signal?.throwIfAborted();
    if (!page.size) return;
    const events = [...page.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    for (const event of events) {
      options.signal?.throwIfAborted();
      if (!boundaryIDs.has(event.id)) await onEvent(event);
    }
    const oldest = events[events.length - 1].created_at;
    const nextBoundaryIDs = new Set(events.filter(e => e.created_at === oldest).map(e => e.id));
    if (oldest < until) {
      // Re-read the boundary second, rather than losing records tied with the
      // last event on a capped page. Do not infer completeness from a short page.
      until = oldest;
      boundaryIDs = nextBoundaryIDs;
      limit = pageSize;
      continue;
    }
    if (page.size >= effectiveLimit) {
      if (limit >= maxPageSize || effectiveLimit < limit) {
        throw new Error(`History timestamp ${until} exceeds the relay page limit`);
      }
      for (const id of nextBoundaryIDs) boundaryIDs.add(id);
      limit = Math.min(maxPageSize, limit * 2);
      continue;
    }
    until = oldest - 1;
    boundaryIDs = new Set();
    limit = pageSize;
  }
}
