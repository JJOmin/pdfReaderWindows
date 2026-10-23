import { describe, expect, it } from 'vitest';
import { guessLang, sentenceLang } from '../../src/shared/language';
import type { Block } from '../../src/shared/layout';
import type { Utterance } from '../../src/shared/types';
import { buildUtterances, isReferenceHeading, joinedPage } from '../../src/shared/utterances';

/** A block whose text is also the page's raw string. */
const block = (text: string, heading = false): Block => ({
  text,
  raw: Array.from(text, (_, i) => i),
  heading,
});

describe('guessLang', () => {
  it('recognises German and English sentences', () => {
    expect(guessLang('Die Methode ist nicht neu und wird oft verwendet.')).toEqual({
      lang: 'de',
      confident: true,
    });
    expect(guessLang('The method is not new and has been used for years.')).toEqual({
      lang: 'en',
      confident: true,
    });
  });

  it('falls back to the document language without evidence', () => {
    expect(sentenceLang('Transformer Encoder Layer', 'de')).toBe('de');
    expect(sentenceLang('Transformer Encoder Layer', 'en')).toBe('en');
  });
});

describe('buildUtterances', () => {
  it('splits a paragraph into sentences with their words', () => {
    const [first, second] = buildUtterances([block('We test it. It works well.')], 3, 'en');
    expect(first?.text).toBe('We test it.');
    expect(first?.page).toBe(3);
    expect(first?.words.map((w) => w.text)).toEqual(['We', 'test', 'it']);
    expect(second?.words[0]?.ranges).toEqual([[12, 14]]);
  });

  it('does not split at abbreviations, initials or German ordinals', () => {
    const en = buildUtterances(
      [block('As shown by Smith et al. Results in Fig. 2 hold, cf. J. Doe.')],
      1,
      'en',
    );
    expect(en).toHaveLength(1);
    const de = buildUtterances([block('Das gilt z. B. für den 3. Mai. Danach nicht.')], 1, 'de');
    expect(de.map((u) => u.text)).toEqual(['Das gilt z. B. für den 3. Mai.', 'Danach nicht.']);
  });

  it('gives an English sentence in a German text to the English voice', () => {
    const utterances = buildUtterances(
      [block('Das Modell ist sehr groß. The authors did not release the code for this. Das ist schade.')],
      1,
      'de',
    );
    expect(utterances.map((u) => u.lang)).toEqual(['de', 'en', 'de']);
  });

  it('splits at a colon that introduces a quote or a clause in the other language', () => {
    const utterances = buildUtterances(
      [
        block(
          'Die Autoren schreiben: The proposed method is simple and it does not need data. Ein Satz lautet: „Der Mensch spielt gern.“',
        ),
      ],
      1,
      'de',
    );
    expect(utterances.map((u) => [u.lang, u.role, u.text])).toEqual([
      ['de', 'main', 'Die Autoren schreiben:'],
      ['en', 'main', 'The proposed method is simple and it does not need data.'],
      ['de', 'main', 'Ein Satz lautet:'],
      ['de', 'quote', '„Der Mensch spielt gern.“'],
    ]);
  });

  it('assigns the heading and quote roles', () => {
    const utterances = buildUtterances(
      [
        block('2 Methode', true),
        block('Er schrieb: Es geht. „Das ist der erste Satz. Und der zweite.“ Danach folgt Text.'),
      ],
      1,
      'de',
    );
    expect(utterances.map((u) => u.role)).toEqual(['heading', 'main', 'quote', 'quote', 'main']);
  });

  it('skips numeric citations in speech but keeps the visible text', () => {
    const [u] = buildUtterances([block('This was shown before [3, 14] and later [7].')], 1, 'en');
    expect(u?.spoken).toBe('This was shown before and later.');
    expect(u?.text).toContain('[3, 14]');
    expect(u?.words.map((w) => w.text)).toEqual(['This', 'was', 'shown', 'before', 'and', 'later']);
  });
});

describe('isReferenceHeading', () => {
  const heading = (text: string, role: 'heading' | 'main' = 'heading'): Utterance => ({
    page: 1,
    text,
    spoken: text,
    lang: 'en',
    role,
    words: [],
    ranges: [],
  });

  it('knows the reference list by its heading, numbered or not, in English and German', () => {
    for (const text of [
      'References',
      'REFERENCES',
      '7 References',
      'VII. References',
      'Bibliography',
      'Literatur',
      '6.1 Literaturverzeichnis',
      'Works Cited',
      'Quellenverzeichnis',
      'Literature',
    ]) {
      expect(isReferenceHeading(heading(text)), text).toBe(true);
    }
  });

  it('is the heading set as body text too, but not a sentence or heading that only mentions references', () => {
    expect(isReferenceHeading(heading('REFERENCES', 'main'))).toBe(true);
    expect(isReferenceHeading(heading('See the references.', 'main'))).toBe(false);
    for (const text of ['References to prior work', 'Related Work', 'Literature review']) {
      expect(isReferenceHeading(heading(text)), text).toBe(false);
    }
  });
});

describe('joinedPage (ADR 12)', () => {
  const u = (page: number, text: string, role: Utterance['role'] = 'main'): Utterance => ({
    page,
    text,
    spoken: text,
    lang: 'en',
    role,
    words: text
      .split(' ')
      .map((w, i) => ({ text: w.replace(/[.,]/gu, ''), ranges: [[i * 10, i * 10 + w.length]] })),
    ranges: [[0, text.length]],
  });
  const page1 = [u(1, 'First sentence.'), u(1, 'This sentence runs over')];
  const page2 = [u(2, 'the page break.'), u(2, 'Then another one.')];

  it('joins the next page’s start onto a sentence that has no end, its words on their own page', () => {
    const joined = joinedPage(undefined, page1, page2);
    expect(joined.map((s) => s.text)).toEqual(['First sentence.', 'This sentence runs over the page break.']);
    const last = joined[1]!;
    expect(last.page).toBe(1);
    expect(last.next).toEqual({ page: 2, ranges: [[0, 15]] });
    expect(last.words.map((w) => w.page)).toEqual([undefined, undefined, undefined, undefined, 2, 2, 2]);
    expect(last.words.at(-1)).toEqual({ text: 'break', ranges: [[20, 26]], page: 2 });
  });

  it('leaves the joined start out of the next page', () => {
    expect(joinedPage(page1, page2, undefined).map((s) => s.text)).toEqual(['Then another one.']);
  });

  it('joins nothing after a sentence end, a colon, or a heading on either side', () => {
    for (const ending of ['Ends here.', 'Asked?', 'As follows:', '“Quoted.”']) {
      expect(joinedPage(undefined, [u(1, ending)], page2)).toHaveLength(1);
    }
    expect(joinedPage(undefined, [u(1, '2 Methods', 'heading')], page2)).toHaveLength(1);
    expect(joinedPage(undefined, page1, [u(2, 'Results', 'heading')])).toHaveLength(2);
    expect(joinedPage(undefined, page1, [u(2, 'Results', 'heading')])[1]!.next).toBeUndefined();
  });

  it('is the page as it is on the last page, and for an empty one', () => {
    expect(joinedPage(undefined, page1, undefined)).toEqual(page1);
    expect(joinedPage(undefined, [], page2)).toEqual([]);
  });
});
