import { describe, expect, it } from 'vitest';
import { focusBand, scrollToCentre } from '../../src/renderer/src/focus';

describe('focusBand', () => {
  const sentence = { top: 100, bottom: 160 };
  const word = { top: 120, bottom: 140 };

  it('takes the whole sentence when it fits in the view', () => {
    expect(focusBand(sentence, word, 600)).toBe(sentence);
  });

  it('takes the word when the sentence is taller than 60 % of the view', () => {
    // 60 is more than 60 % of 90, and exactly 60 % of 100 is still the sentence.
    expect(focusBand(sentence, word, 90)).toBe(word);
    expect(focusBand(sentence, word, 100)).toBe(sentence);
  });

  it('keeps the sentence when no word is known yet', () => {
    expect(focusBand(sentence, undefined, 90)).toBe(sentence);
  });
});

describe('scrollToCentre', () => {
  it('is how far the band is below, or above, the middle', () => {
    expect(scrollToCentre({ top: 400, bottom: 500 }, 300)).toBe(150);
    expect(scrollToCentre({ top: 0, bottom: 100 }, 300)).toBe(-250);
    expect(scrollToCentre({ top: 250, bottom: 350 }, 300)).toBe(0);
  });
});
