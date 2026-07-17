/**
 * Classic bounded worker-pool. Runs `fn` over every item with at most
 * `concurrency` calls in flight at once. Results land in INPUT order,
 * regardless of completion order — this is what makes pipeline composable.
 *
 * Deliberately tiny (≤10 scale): no queue, no backpressure, no cancellation.
 */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  // Edge case: empty list → no workers, returns [].
  const width = Math.min(concurrency, items.length)
  let cursor = 0
  const workers = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}
