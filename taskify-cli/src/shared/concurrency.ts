/**
 * Relays cap concurrent REQs per connection (strfry: "too many concurrent REQs"). Fetching every
 * board at once opened one REQ per board per relay; this keeps a few in flight. Results keep the
 * input order.
 */
export const MAX_CONCURRENT_BOARD_FETCHES = 3;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
