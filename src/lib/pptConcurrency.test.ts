import { describe, expect, it } from 'vitest'
import { clampPptConcurrency, runWithConcurrency } from './pptConcurrency'

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('pptConcurrency', () => {
  it('clamps concurrency to a bounded range', () => {
    expect(clampPptConcurrency(0)).toBe(1)
    expect(clampPptConcurrency(2.6)).toBe(3)
    expect(clampPptConcurrency(99)).toBe(5)
    expect(clampPptConcurrency(Number.NaN)).toBe(5)
  })

  it('does not exceed the requested concurrency', async () => {
    let active = 0
    let maxActive = 0
    const order: number[] = []

    await runWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(1)
      order.push(item)
      active -= 1
    })

    expect(maxActive).toBeLessThanOrEqual(2)
    expect(order.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('stops assigning new work when shouldContinue turns false', async () => {
    const started: number[] = []
    let keepGoing = true

    await runWithConcurrency([1, 2, 3, 4, 5], 1, async (item) => {
      started.push(item)
      keepGoing = false
    }, () => keepGoing)

    expect(started).toEqual([1])
  })
})
