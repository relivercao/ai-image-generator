export const DEFAULT_PPT_CONCURRENCY = 5
export const MAX_PPT_CONCURRENCY = 5

export function clampPptConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PPT_CONCURRENCY
  return Math.min(MAX_PPT_CONCURRENCY, Math.max(1, Math.round(value)))
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const workerCount = Math.min(items.length, clampPptConcurrency(concurrency))
  let nextIndex = 0

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (shouldContinue()) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      await worker(items[index], index)
    }
  }))
}
