/** A vertical stretch on screen, in client coordinates. */
export interface Band {
  top: number;
  bottom: number;
}

/** A sentence taller than this share of the view cannot be centred as a whole. */
export const TALL = 0.6;

/**
 * What to put in the middle of the view: the whole sentence, or, when it is taller than
 * `TALL` of the view, the line being read, so the eye stays where the voice is.
 */
export function focusBand(sentence: Band, word: Band | undefined, viewHeight: number): Band {
  const tall = sentence.bottom - sentence.top > TALL * viewHeight;
  return tall && word ? word : sentence;
}

/** How far to scroll, positive downwards, to bring the middle of `band` to `middle`. */
export const scrollToCentre = (band: Band, middle: number): number => (band.top + band.bottom) / 2 - middle;
