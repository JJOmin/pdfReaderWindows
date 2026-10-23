import { describe, expect, it } from 'vitest';
import { layoutPage, rawRanges } from '../../src/shared/layout';
import type { RawItem } from '../../src/shared/types';

const PAGE_HEIGHT = 800;

/** One PDF line as a single text run. */
const line = (str: string, y: number, opts: Partial<RawItem> = {}): RawItem => ({
  str,
  x: 72,
  y,
  height: 10,
  font: 'body',
  hasEOL: true,
  rotated: false,
  ...opts,
});

describe('layoutPage', () => {
  it('joins the lines of a paragraph with spaces', () => {
    const [block] = layoutPage([line('First line', 700), line('second line.', 688)], PAGE_HEIGHT);
    expect(block?.text).toBe('First line second line.');
    expect(block?.heading).toBe(false);
  });

  it('undoes hyphenation at a line break', () => {
    const [block] = layoutPage([line('Die Ent-', 700), line('wicklung läuft.', 688)], PAGE_HEIGHT);
    expect(block?.text).toBe('Die Entwicklung läuft.');
  });

  it('keeps the hyphen of a compound and of an omitted word part', () => {
    const compound = layoutPage([line('Benchmark-', 700), line('Datensätze.', 688)], PAGE_HEIGHT);
    expect(compound[0]?.text).toBe('Benchmark-Datensätze.');
    const omitted = layoutPage([line('Vor-', 700), line('und Nachteile.', 688)], PAGE_HEIGHT);
    expect(omitted[0]?.text).toBe('Vor- und Nachteile.');
    const chain = layoutPage([line('state-of-the-', 700), line('art results.', 688)], PAGE_HEIGHT);
    expect(chain[0]?.text).toBe('state-of-the-art results.');
  });

  it('maps every character back to its place in the page', () => {
    const items = [line('Die Ent-', 700), line('wicklung.', 688)];
    const [block] = layoutPage(items, PAGE_HEIGHT);
    const pageRaw = items.map((i) => i.str).join('');
    const word = block!.text.indexOf('Entwicklung');
    const ranges = rawRanges(block!.raw, word, word + 'Entwicklung'.length);
    // The removed hyphen splits the word into its two visible halves.
    expect(ranges.map(([a, b]) => pageRaw.slice(a, b))).toEqual(['Ent', 'wicklung']);
  });

  it('expands ligatures without losing the mapping', () => {
    const [block] = layoutPage([line('efﬁcient', 700)], PAGE_HEIGHT);
    expect(block?.text).toBe('efficient');
    expect(rawRanges(block!.raw, 0, block!.text.length)).toEqual([[0, 8]]);
  });

  it('marks larger and numbered lines as headings', () => {
    const blocks = layoutPage(
      [
        line('A Study of Reading', 740, { height: 16 }),
        line('This is the body text of the paper. It is long enough to set the size.', 700),
        line('2.1 Related Work', 660, { font: 'bold' }),
        line('More body text that follows the heading and ends properly.', 640),
      ],
      PAGE_HEIGHT,
    );
    expect(blocks.map((b) => b.heading)).toEqual([true, false, true, false]);
  });

  it('drops page numbers, running headers and rotated stamps', () => {
    const blocks = layoutPage(
      [
        line('Journal of Examples', 780),
        line('arXiv:1234.5678', 400, { rotated: true }),
        line('Body text that stays in the result.', 600),
        line('7', 30),
      ],
      PAGE_HEIGHT,
    );
    expect(blocks.map((b) => b.text)).toEqual(['Body text that stays in the result.']);
  });

  it('leaves out small figure labels, but keeps captions, small-caps section headings and footnote sentences (backlog 1)', () => {
    const blocks = layoutPage(
      [
        line('This is the body text of the paper. It is long enough to set the size.', 712),
        line('A second line of body text, so that the page has more body than small print.', 700),
        line('And a third one, as a real page has far more body text than labels in it.', 688),
        line('E[CLS] E1 E[SEP]', 600, { height: 8 }),
        line('Input Embeddings', 580, { height: 8 }),
        line('Figure 1: Overview of the model', 540, { height: 8 }),
        line('V. A STUDY ON THE IMPORTANCE OF QUALITY', 500, { height: 8 }),
        line('CRITERIA FOR TUTORIALS', 490, { height: 8 }),
        line('1 This footnote is a sentence of its own.', 120, { height: 8 }),
      ],
      PAGE_HEIGHT,
    );
    expect(blocks.map((b) => b.text)).toEqual([
      'This is the body text of the paper. It is long enough to set the size. A second line of body text, so that the page has more body than small print. And a third one, as a real page has far more body text than labels in it.',
      'Figure 1: Overview of the model',
      'V. A STUDY ON THE IMPORTANCE OF QUALITY CRITERIA FOR TUTORIALS',
      '1 This footnote is a sentence of its own.',
    ]);
  });

  it('leaves out table rows of numbers and displayed formulas, but not sentences with numbers (backlog 1, 2)', () => {
    const blocks = layoutPage(
      [
        line('This is the body text of the paper. It is long enough to set the size.', 700),
        line('I1 2.13 (1.20) I10 0.43 (2.00) I2 1.47 (1.59)', 650),
        line('E = mc² (1)', 600),
        line('f(x) = Σ a_i x^i', 560),
        line('In 2023, 45 % of 1,200 users agreed.', 520),
        line('We set α = 0.5 for all runs.', 500),
        line('RQ1:', 480),
        line('II.', 440),
      ],
      PAGE_HEIGHT,
    );
    expect(blocks.map((b) => b.text)).toEqual([
      'This is the body text of the paper. It is long enough to set the size.',
      'In 2023, 45 % of 1,200 users agreed.',
      'We set α = 0.5 for all runs.',
      'RQ1:',
      'II.',
    ]);
  });

  it('starts a new block when the text jumps to the next column', () => {
    const blocks = layoutPage(
      [line('End of column one.', 100), line('Top of column two.', 700)],
      PAGE_HEIGHT,
    );
    expect(blocks).toHaveLength(2);
  });
});
