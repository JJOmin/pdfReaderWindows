import type { Lang } from './types.ts';

// Function words only. Words common to both languages (in, an, was, war, also, so) are left out.
const WORDS: Record<Lang, Set<string>> = {
  de: new Set(
    `der die das und ist nicht ein eine einer eines einem einen zu mit von für auf den dem des
     sich auch als wie bei oder aber wird werden wurde wurden sind dass durch nach über unter
     zwischen diese dieser dieses diesem ich wir sie es im zum zur vom kann können nur noch
     mehr sehr wenn weil hat haben sein ihre ihr um aus bis ohne gegen beim keine kein
     jedoch sowie damit dabei daher dies man`.split(/\s+/),
  ),
  en: new Set(
    `the and of to is that for with as on are be this by it were which or from at have has
     not but can we our their these those its into than been would should could there what
     when where who will more most such may between using used use if then they you your
     his her all any each both does did do`.split(/\s+/),
  ),
};

export interface LangGuess {
  lang: Lang;
  /** True when the evidence is strong enough to override the document's language. */
  confident: boolean;
}

/** Guesses German or English from function words. Built for sentences, not single words. */
export function guessLang(text: string): LangGuess {
  const score: Record<Lang, number> = { de: 0, en: 0 };
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (WORDS.de.has(word) || /[äöüß]/u.test(word)) score.de++;
    else if (WORDS.en.has(word)) score.en++;
  }
  const lang: Lang = score.de > score.en ? 'de' : 'en';
  const other = lang === 'de' ? score.en : score.de;
  return { lang, confident: score[lang] >= 2 && score[lang] >= 2 * other };
}

/** Language of a sentence, falling back to the document's language when the sentence is ambiguous. */
export function sentenceLang(text: string, documentLang: Lang): Lang {
  const guess = guessLang(text);
  return guess.confident ? guess.lang : documentLang;
}
