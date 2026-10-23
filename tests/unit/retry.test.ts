import { describe, expect, it } from 'vitest';
import { retry } from '../../src/shared/retry';

const noWait = async (): Promise<void> => undefined;

describe('retry', () => {
  it('returns what the task returns, without another try', async () => {
    let calls = 0;
    expect(await retry(async () => ++calls, { attempts: 3, wait: noWait })).toBe(1);
    expect(calls).toBe(1);
  });

  it('tries again after a failure and returns the first success', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        if (++calls < 3) throw new Error(`fail ${calls}`);
        return 'done';
      },
      { attempts: 5, wait: noWait },
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('gives up after the last attempt with the last error', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          throw new Error(`fail ${++calls}`);
        },
        { attempts: 3, wait: noWait },
      ),
    ).rejects.toThrow('fail 3');
    expect(calls).toBe(3);
  });

  it('waits longer each time, and says what failed', async () => {
    const waits: number[] = [];
    const told: string[] = [];
    await expect(
      retry(
        async () => {
          throw new Error('boom');
        },
        {
          attempts: 4,
          delayMs: 1000,
          wait: async (ms) => void waits.push(ms),
          onRetry: (error, attempt) => told.push(`${attempt}: ${(error as Error).message}`),
        },
      ),
    ).rejects.toThrow('boom');
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(told).toEqual(['1: boom', '2: boom', '3: boom']);
  });

  it('tries at least once, whatever it is asked', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          throw new Error(`fail ${++calls}`);
        },
        { attempts: 0, wait: noWait },
      ),
    ).rejects.toThrow('fail 1');
  });
});
