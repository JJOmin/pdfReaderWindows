import { requestKey } from './render-cache.ts';
import type { SynthRequest } from './types.ts';

export interface PrerenderProgress {
  /** Pages finished, out of `pages`. */
  pagesDone: number;
  pages: number;
  rendered: number;
  /** Sentences left alone: another voice reads them, or the same sound was already rendered. */
  skipped: number;
  failed: number;
}

export type PrerenderResult = PrerenderProgress & { cancelled: boolean };

/** What a pre-render needs from the document and from the speech side. `U` is a sentence. */
export interface PrerenderHost<U> {
  pageCount(): number;
  utterances(page: number): Promise<U[]>;
  /** The request that speaks the sentence, or undefined when a voice that is not rendered reads it. */
  request(utterance: U): SynthRequest | undefined;
  render(request: SynthRequest): Promise<void>;
  progress(state: PrerenderProgress): void;
}

/** After this many failures in a row the voice is taken to be down, and the job stops. */
const GIVE_UP_AFTER = 3;

/** The pages in the order they are rendered: from `from` to the end, then the pages before it. */
export function pageOrder(pageCount: number, from: number): number[] {
  // A start outside the document (no page yet, or a stale one) means the beginning.
  const start = Number.isInteger(from) && from >= 1 && from <= pageCount ? from : 1;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  return [...pages.slice(start - 1), ...pages.slice(0, start - 1)];
}

/**
 * Renders every sentence of the document that a rendered voice reads, one at a time, starting
 * where the reader is. One at a time, so that a sentence somebody is waiting for can go first.
 */
export async function prerender<U>(
  host: PrerenderHost<U>,
  fromPage: number,
  signal?: AbortSignal,
): Promise<PrerenderResult> {
  const order = pageOrder(host.pageCount(), fromPage);
  const state: PrerenderProgress = { pagesDone: 0, pages: order.length, rendered: 0, skipped: 0, failed: 0 };
  const seen = new Set<string>();
  let streak = 0;
  host.progress({ ...state });

  for (const page of order) {
    if (signal?.aborted) return { ...state, cancelled: true };
    for (const utterance of await host.utterances(page)) {
      if (signal?.aborted) return { ...state, cancelled: true };
      const request = host.request(utterance);
      const key = request && requestKey(request);
      if (!request || seen.has(key!)) {
        state.skipped += 1;
        continue;
      }
      seen.add(key!);
      try {
        await host.render(request);
        state.rendered += 1;
        streak = 0;
      } catch (error) {
        state.failed += 1;
        // A sentence the engine cannot speak is not worth the whole document; a dead engine is.
        if (++streak >= GIVE_UP_AFTER) throw error;
      }
      host.progress({ ...state });
    }
    state.pagesDone += 1;
    host.progress({ ...state });
  }
  return { ...state, cancelled: false };
}
