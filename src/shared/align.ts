import type { WordTiming } from './types.ts';

const GAP_COST = 0.6;
const MIN_SIMILARITY = 0.5;

const normalize = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a === '' || b === '') return 0;
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next.push(Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    row = next;
  }
  return 1 - row[b.length]! / Math.max(a.length, b.length);
}

/** Turns known start times into full timings. Unknown starts are interpolated by word length. */
function fill(words: string[], starts: (number | undefined)[], duration: number): WordTiming[] {
  const weight = words.map((w) => w.length + 2);
  const out: number[] = [];
  let from = 0;
  for (let i = 0; i < words.length;) {
    if (starts[i] !== undefined) {
      from = Math.max(from, starts[i]!);
      out.push(from);
      i++;
      continue;
    }
    // A run of unknown words shares the time up to the next known word.
    let j = i;
    while (j < words.length && starts[j] === undefined) j++;
    const to = Math.max(from, j < words.length ? starts[j]! : duration);
    // The known word before the run keeps its own share of that time.
    const before = i > 0 ? weight[i - 1]! : 0;
    const total = weight.slice(i, j).reduce((a, b) => a + b, before);
    let acc = before;
    for (let k = i; k < j; k++) {
      out.push(from + ((to - from) * acc) / total);
      acc += weight[k]!;
    }
    from = to;
    i = j;
  }
  return out.map((start, k) => ({ start, end: out[k + 1] ?? Math.max(start, duration) }));
}

/** Spreads `duration` over the words by length. Used when nothing was measured. */
export function estimateTimings(words: string[], duration: number): WordTiming[] {
  return fill(
    words,
    words.map(() => undefined),
    duration,
  );
}

/**
 * Finds when each expected word is spoken, given what a speech recogniser heard in the
 * synthesised audio. Recogniser tokens are word pieces; a leading space or "▁" starts a word.
 */
export function alignWords(
  words: string[],
  tokens: string[],
  timestamps: number[],
  duration: number,
): WordTiming[] {
  const heard: { text: string; start: number }[] = [];
  tokens.forEach((token, i) => {
    const piece = token.replace(/^[\s▁]+/u, '');
    if (piece !== token || heard.length === 0) heard.push({ text: '', start: timestamps[i] ?? 0 });
    heard.at(-1)!.text += piece;
  });
  const expected = words.map(normalize);
  const actual = heard.map((h) => normalize(h.text));

  // Edit-distance alignment of the two word sequences. Besides the usual match and skip,
  // a move may pair one word with two: recognisers split and join compounds freely.
  const n = expected.length;
  const m = actual.length;
  type Move = [di: number, dj: number, cost: number];
  const best = Array.from({ length: n + 1 }, () => new Array<{ cost: number; move?: Move }>(m + 1));
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) {
        best[0]![0] = { cost: 0 };
        continue;
      }
      const moves: Move[] = [];
      if (i > 0) moves.push([1, 0, GAP_COST]);
      if (j > 0) moves.push([0, 1, GAP_COST]);
      if (i > 0 && j > 0) moves.push([1, 1, 1 - similarity(expected[i - 1]!, actual[j - 1]!)]);
      if (i > 0 && j > 1)
        moves.push([1, 2, 1 - similarity(expected[i - 1]!, actual[j - 2]! + actual[j - 1]!)]);
      if (i > 1 && j > 0)
        moves.push([2, 1, 1 - similarity(expected[i - 2]! + expected[i - 1]!, actual[j - 1]!)]);
      best[i]![j] = moves
        .map((move) => ({ cost: best[i - move[0]]![j - move[1]]!.cost + move[2], move }))
        .reduce((a, b) => (b.cost < a.cost ? b : a));
    }
  }
  const starts: (number | undefined)[] = words.map(() => undefined);
  for (let i = n, j = m; i > 0 || j > 0;) {
    const [di, dj, cost] = best[i]![j]!.move!;
    i -= di;
    j -= dj;
    // Only the first word of a pairing gets the measured start; a second one is interpolated.
    if (di > 0 && dj > 0 && 1 - cost >= MIN_SIMILARITY) starts[i] = heard[j]!.start;
  }
  return fill(words, starts, duration);
}
