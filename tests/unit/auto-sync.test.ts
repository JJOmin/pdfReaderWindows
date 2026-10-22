import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoSync } from '../../src/shared/auto-sync';

let runs: number[];
let auto: AutoSync;
let slow: Promise<void> | undefined;
const sec = async (n: number): Promise<void> => void (await vi.advanceTimersByTimeAsync(n * 1000));

beforeEach(() => {
  vi.useFakeTimers();
  runs = [];
  slow = undefined;
  auto = new AutoSync({
    run: async () => {
      runs.push(Date.now());
      await slow;
    },
    now: () => Date.now(),
  });
});
afterEach(() => {
  auto.stop();
  vi.useRealTimers();
});

describe('AutoSync', () => {
  it('syncs at once on start, then every two minutes', async () => {
    auto.start();
    await sec(0);
    expect(runs).toHaveLength(1);
    await sec(119);
    expect(runs).toHaveLength(1);
    await sec(1);
    expect(runs).toHaveLength(2);
    await sec(120);
    expect(runs).toHaveLength(3);
  });

  it('sends at most 10 seconds after the first change not yet sent, however many follow (ADR 11)', async () => {
    auto.start();
    await sec(0);
    runs.length = 0;
    auto.changed('content');
    await sec(6);
    // A page rendered every few seconds must not put the upload off to the last one.
    auto.changed('content');
    await sec(3);
    expect(runs).toHaveLength(0);
    await sec(1);
    expect(runs).toHaveLength(1);
    auto.changed('content');
    await sec(10);
    expect(runs).toHaveLength(2);
  });

  it('lets a place be sent at most once a minute', async () => {
    auto.start();
    await sec(0);
    runs.length = 0;
    await sec(5);
    auto.changed('place');
    await sec(10);
    // The start sync was 15 s ago: the place waits for the minute to pass.
    expect(runs).toHaveLength(0);
    await sec(45);
    expect(runs).toHaveLength(1);
  });

  it('sends a place 10 seconds after it changed when the last sync was long ago', async () => {
    auto.start();
    await sec(0);
    runs.length = 0;
    await sec(100);
    auto.changed('place');
    await sec(10);
    expect(runs).toHaveLength(1);
  });

  it('does not delay a mark behind a place', async () => {
    auto.start();
    await sec(0);
    runs.length = 0;
    auto.changed('place');
    await sec(2);
    auto.changed('content');
    await sec(10);
    expect(runs).toHaveLength(1);
  });

  it('never runs two syncs at once, and runs again after one that a change interrupted', async () => {
    let release!: () => void;
    slow = new Promise((resolve) => (release = resolve));
    auto.start();
    await sec(0);
    auto.changed('content');
    await sec(10);
    expect(runs).toHaveLength(1);
    release();
    slow = undefined;
    await sec(0);
    expect(runs).toHaveLength(2);
  });

  it('keeps going after a sync that failed', async () => {
    let fail = true;
    const failing = new AutoSync({
      run: () => {
        runs.push(Date.now());
        return fail ? Promise.reject(new Error('offline')) : Promise.resolve();
      },
      now: () => Date.now(),
    });
    failing.start();
    await sec(0);
    fail = false;
    await sec(120);
    expect(runs).toHaveLength(2);
    failing.stop();
  });

  it('does nothing while switched off, and syncs when switched on', async () => {
    auto.setEnabled(false);
    auto.start();
    auto.changed('content');
    await sec(300);
    expect(runs).toHaveLength(0);
    auto.setEnabled(true);
    await sec(0);
    expect(runs).toHaveLength(1);
  });

  it('syncs when asked to, as when the app quits with a change waiting, and says if it did', async () => {
    auto.start();
    await sec(0);
    runs.length = 0;
    expect(await auto.flush()).toBe(false);
    auto.changed('content');
    expect(await auto.flush()).toBe(true);
    expect(runs).toHaveLength(1);
    await sec(30);
    expect(runs).toHaveLength(1);
  });
});
