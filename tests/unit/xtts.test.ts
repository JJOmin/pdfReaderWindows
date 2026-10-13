import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Xtts, type XttsOptions } from '../../src/main/xtts';
import type { SynthRequest } from '../../src/shared/types';

const helper = join(import.meta.dirname, '../fixtures/fake-xtts-helper.mjs');
let dir: string;
let voice: Xtts | undefined;

const say = (text: string, over: Partial<SynthRequest> = {}): SynthRequest => ({
  text,
  words: [],
  lang: 'en',
  voice: { model: 'xtts', sid: 0 },
  speed: 1,
  ...over,
});
const make = (over: Partial<XttsOptions> = {}): Xtts =>
  (voice = new Xtts({
    command: process.execPath,
    args: [helper],
    cacheDir: join(dir, 'cache'),
    speakers: { 0: 'Test Speaker' },
    ...over,
  }));
/** What the fake helper wrote: "<n-th request it served>:<text>:<speaker>:<speed>". */
const heard = (path: string): string => readFileSync(path, 'utf8');
const order = async (...paths: Promise<string>[]): Promise<string[]> =>
  (await Promise.all(paths)).map((p) => heard(p).split(':')[1]!);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xtts-test-'));
});
afterEach(() => {
  voice?.close();
  voice = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('Xtts', () => {
  it('renders a sentence with the speaker and speed, and reuses the file', async () => {
    const xtts = make();
    const first = await xtts.render(say('Hello', { speed: 1.25 }), 'live');
    expect(heard(first)).toBe('1:Hello:Test Speaker:1.25');
    const again = await xtts.render(say('Hello', { speed: 1.25 }), 'live');
    expect(again).toBe(first);
    // The helper served only one request: the second answer came from the cache.
    const next = await xtts.render(say('World'), 'live');
    expect(heard(next).startsWith('2:')).toBe(true);
  });

  it('finds what an earlier session rendered', async () => {
    const path = await make().render(say('Persisted'), 'live');
    voice?.close();
    const second = make();
    expect(await second.render(say('Persisted'), 'live')).toBe(path);
    expect(heard(path).startsWith('1:')).toBe(true);
  });

  it('serves a sentence being waited for before sentences being prepared', async () => {
    const xtts = make();
    const a = xtts.render(say('a'), 'background');
    const b = xtts.render(say('b'), 'background');
    const c = xtts.render(say('c'), 'background');
    const live = xtts.render(say('live'), 'live');
    // "a" was already with the helper; then the live one overtakes b and c.
    expect(await order(a, live, b, c)).toEqual(['a', 'live', 'b', 'c']);
    expect(await Promise.all([a, live, b, c].map(async (p) => heard(await p).split(':')[0]))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('moves a waiting sentence forward when it is asked for as live', async () => {
    const xtts = make();
    const a = xtts.render(say('a'), 'background');
    const b = xtts.render(say('b'), 'background');
    const c = xtts.render(say('c'), 'background');
    const sameAsC = xtts.render(say('c'), 'live');
    expect(await sameAsC).toBe(await c);
    const numbers = await Promise.all([a, b, c].map(async (p) => Number(heard(await p).split(':')[0])));
    expect(numbers).toEqual([1, 3, 2]);
  });

  it('fails one sentence without stopping the helper', async () => {
    const xtts = make();
    await expect(xtts.render(say('FAIL'), 'live')).rejects.toThrow('ValueError: no');
    expect(heard(await xtts.render(say('fine'), 'live')).startsWith('1:fine')).toBe(true);
  });

  it('reports a crash to everything waiting, then starts a new helper', async () => {
    const xtts = make();
    const crashing = xtts.render(say('CRASH'), 'live');
    const waiting = xtts.render(say('queued'), 'background');
    await expect(crashing).rejects.toThrow(/exited \(code 3\)/u);
    await expect(waiting).rejects.toThrow(/exited/u);
    // A fresh helper counts from one again.
    expect(heard(await xtts.render(say('after'), 'live')).startsWith('1:after')).toBe(true);
  });

  it('reports a helper that cannot be started', async () => {
    const xtts = make({ command: join(dir, 'no-such-program'), args: [] });
    await expect(xtts.render(say('x'), 'live')).rejects.toThrow(/could not be started/u);
  });

  it('refuses a speaker it does not know', async () => {
    await expect(make().render(say('x', { voice: { model: 'xtts', sid: 9 } }), 'live')).rejects.toThrow(
      'No XTTS speaker 9',
    );
  });

  it('starts again after close', async () => {
    const xtts = make();
    await xtts.render(say('one'), 'live');
    xtts.close();
    expect(heard(await xtts.render(say('two'), 'live')).startsWith('1:two')).toBe(true);
  });

  it('stops the helper after it has been idle, and starts it when asked again', async () => {
    const xtts = make({ idleMs: 150 });
    await xtts.render(say('one'), 'live');
    await new Promise((resolve) => setTimeout(resolve, 600));
    // Had the same helper still been running, the count would be 2.
    expect(heard(await xtts.render(say('two'), 'live')).startsWith('1:two')).toBe(true);
  });

  it('deletes the least recently used files when the cache is over its limit', async () => {
    const xtts = make({ maxCacheBytes: 60, trimEvery: 1 });
    const cache = join(dir, 'cache');
    for (const text of ['first sentence', 'second sentence', 'third sentence', 'fourth sentence']) {
      await xtts.render(say(text), 'live');
      // File times have a coarse resolution on some systems.
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const left = readdirSync(cache).map((name) => heard(join(cache, name)).split(':')[1]);
    expect(left).toContain('fourth sentence');
    expect(left).not.toContain('first sentence');
    expect(left.length).toBeLessThan(4);
  });
});
