import { rawRanges, type Block } from './layout.ts';
import { sentenceLang } from './language.ts';
import type { Lang, Role, Utterance, Word } from './types.ts';

// Endings after which a full stop does not end the sentence, even before a capital letter.
const NO_BREAK =
  /(?:^|[\s(])(?:z\.\s?B|d\.\s?h|u\.\s?a|o\.\s?ä|bzw|vgl|ca|Abb|Tab|Kap|Abs|Nr|Dr|Prof|Fig|Eq|Sec|Ref|No|vs|cf|i\.e|e\.g|et al|\p{L})\.\s*$/u;
const GERMAN_ORDINAL = /(?:^|\s)\d{1,2}\.\s*$/u;
const OPENING_QUOTE = /^[„“"«»‚‘]/u;
const CLOSING_QUOTE = /[“”"«»‘’][\s.,;:!?)\]\d]*$/u;
// A colon that introduces a quotation or a full clause, which may be in another language.
const INTRODUCING_COLON = /:\s+(?=[„“"«»‚‘\p{Lu}])/gu;
// Numeric citations such as [3] or [12, 15-17] are noise when read aloud.
const CITATION = /\[\d+(?:\s*[,;–-]\s*\d+)*\]/gu;

function sentenceSpans(text: string, lang: Lang): [number, number][] {
  const spans: [number, number][] = [];
  for (const { segment, index } of new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text)) {
    const last = spans.at(-1);
    const before = last ? text.slice(last[0], last[1]) : '';
    if (last && (NO_BREAK.test(before) || (lang === 'de' && GERMAN_ORDINAL.test(before)))) {
      last[1] = index + segment.length;
    } else {
      spans.push([index, index + segment.length]);
    }
  }
  // "Sie schreiben: The method is simple." becomes two utterances, each with its own voice.
  const words = (from: number, to: number): number => text.slice(from, to).match(/\p{L}+/gu)?.length ?? 0;
  return spans.flatMap(([start, end]) => {
    const parts: [number, number][] = [];
    let from = start;
    for (const colon of text.slice(start, end).matchAll(INTRODUCING_COLON)) {
      const at = start + colon.index + colon[0].length;
      if (words(from, at) >= 1 && words(at, end) >= 3) {
        parts.push([from, at]);
        from = at;
      }
    }
    return [...parts, [from, end] as [number, number]];
  });
}

/** Splits a page's blocks into the sentences and headings the reader speaks, in order. */
export function buildUtterances(blocks: Block[], page: number, documentLang: Lang): Utterance[] {
  const utterances: Utterance[] = [];
  for (const block of blocks) {
    const spans: [number, number][] = block.heading
      ? [[0, block.text.length]]
      : sentenceSpans(block.text, documentLang);
    let insideQuote = false;
    for (const [start, end] of spans) {
      const text = block.text.slice(start, end).trim();
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const lang = sentenceLang(text, documentLang);

      const opens = OPENING_QUOTE.test(text);
      const role: Role = block.heading ? 'heading' : opens || insideQuote ? 'quote' : 'main';
      if (opens || insideQuote) insideQuote = !CLOSING_QUOTE.test(text);

      // Blanking keeps every offset stable, so words still map back to the page.
      const masked = block.text.slice(start, end).replace(CITATION, (m) => ' '.repeat(m.length));
      const words: Word[] = [];
      for (const w of new Intl.Segmenter(lang, { granularity: 'word' }).segment(masked)) {
        if (!w.isWordLike) continue;
        const from = start + w.index;
        words.push({ text: w.segment, ranges: rawRanges(block.raw, from, from + w.segment.length) });
      }
      if (words.length === 0) continue;
      utterances.push({
        page,
        text,
        spoken: masked
          .replace(/\s+/gu, ' ')
          .replace(/ ([.,;:!?])/gu, '$1')
          .trim(),
        lang,
        role,
        words,
        ranges: rawRanges(block.raw, start, end),
      });
    }
  }
  return utterances;
}
