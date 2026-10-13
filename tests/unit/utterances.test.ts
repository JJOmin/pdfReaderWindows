import { describe, expect, it } from 'vitest';
import { guessLang, sentenceLang } from '../../src/shared/language';
import type { Block } from '../../src/shared/layout';
import { buildUtterances } from '../../src/shared/utterances';

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
