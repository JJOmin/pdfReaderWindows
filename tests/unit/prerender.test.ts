import { describe, expect, it } from 'vitest';
import { pageOrder, prerender, type PrerenderHost, type PrerenderProgress } from '../../src/shared/prerender';
import type { SynthRequest } from '../../src/shared/types';

const speak = (text: string): SynthRequest => ({
  text,
  words: [],
  lang: 'en',
  voice: { model: 'xtts', sid: 0 },
  speed: 1,
});

/** A document of pages of sentences, where the request for a sentence is the sentence itself. */
function host(pages: string[][], over: Partial<PrerenderHost<string>> = {}) {
  const rendered: string[] = [];
  const states: PrerenderProgress[] = [];
  const h: PrerenderHost<string> = {
    pageCount: () => pages.length,
    utterances: async (page) => pages[page - 1]!,
    request: speak,
    render: async ({ text }) => void rendered.push(text),
    progress: (state) => void states.push(state),
    ...over,
  };
  return { h, rendered, states };
}

describe('pageOrder', () => {
  it('goes from the page to the end, then wraps', () => {
    expect(pageOrder(4, 3)).toEqual([3, 4, 1, 2]);
    expect(pageOrder(3, 1)).toEqual([1, 2, 3]);
  });

  it('starts at the beginning when the page is outside the document', () => {
    expect(pageOrder(3, 0)).toEqual([1, 2, 3]);
    expect(pageOrder(3, 99)).toEqual([1, 2, 3]);
    expect(pageOrder(3, Number.NaN)).toEqual([1, 2, 3]);
    expect(pageOrder(0, 1)).toEqual([]);
  });
});

describe('prerender', () => {
  it('renders from the given page to the end, then the pages before it', async () => {
    const { h, rendered } = host([['p1a'], ['p2a', 'p2b'], ['p3a'], ['p4a']]);
    await prerender(h, 3);
    expect(rendered).toEqual(['p3a', 'p4a', 'p1a', 'p2a', 'p2b']);
  });

  it('says when each page is done, right after its sentences (ADR 11)', async () => {
    const events: string[] = [];
    const { h } = host([['p1a'], ['p2a', 'p2b']], {
      render: async ({ text }) => void events.push(text),
      pageDone: async (page) => void events.push(`page ${page}`),
    });
    await prerender(h, 1);
    expect(events).toEqual(['p1a', 'page 1', 'p2a', 'p2b', 'page 2']);
  });

  it('leaves out the pages that have audio already, and counts them done', async () => {
    const done: number[] = [];
    const { h, rendered, states } = host([['p1a'], ['p2a'], ['p3a']], {
      skip: (page) => page === 2,
      pageDone: async (page) => void done.push(page),
    });
    await prerender(h, 1);
    expect(rendered).toEqual(['p1a', 'p3a']);
    expect(done).toEqual([1, 3]);
    expect(states.at(-1)?.pagesDone).toBe(3);
  });

  it('renders a repeated sentence once', async () => {
    const { h, rendered } = host([['Figure 1.', 'Text.'], ['Figure 1.']]);
    const result = await prerender(h, 1);
    expect(rendered).toEqual(['Figure 1.', 'Text.']);
    expect(result).toMatchObject({ rendered: 2, skipped: 1 });
  });

  it('skips sentences that another voice reads', async () => {
    const { h, rendered } = host([['a', 'b', 'c']], {
      request: (text) => (text === 'b' ? undefined : speak(text)),
    });
    const result = await prerender(h, 1);
    expect(rendered).toEqual(['a', 'c']);
    expect(result).toMatchObject({ rendered: 2, skipped: 1 });
  });

  it('reports progress by sentence and by page', async () => {
    const { h, states } = host([['a', 'b'], ['c']]);
    await prerender(h, 1);
    expect(states.at(-1)).toMatchObject({ pagesDone: 2, pages: 2, rendered: 3 });
    const counts = states.map((s) => s.rendered);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it('stops between sentences when cancelled and says so', async () => {
    const controller = new AbortController();
    const done: string[] = [];
    const { h } = host([['a', 'b', 'c']], {
      render: async ({ text }) => {
        done.push(text);
        if (text === 'a') controller.abort();
      },
    });
    const result = await prerender(h, 1, controller.signal);
    expect(done).toEqual(['a']);
    expect(result.cancelled).toBe(true);
  });

  it('carries on past a sentence that fails, and counts it', async () => {
    const done: string[] = [];
    const { h } = host([['a', 'bad', 'c']], {
      render: async ({ text }) => {
        if (text === 'bad') throw new Error('boom');
        done.push(text);
      },
    });
    const result = await prerender(h, 1);
    expect(done).toEqual(['a', 'c']);
    expect(result).toMatchObject({ rendered: 2, failed: 1, cancelled: false });
  });

  it('gives up with the error when the voice is plainly down', async () => {
    const { h } = host([['a', 'b', 'c', 'd', 'e']], {
      render: async () => {
        throw new Error('helper has exited');
      },
    });
    await expect(prerender(h, 1)).rejects.toThrow('helper has exited');
  });
});
