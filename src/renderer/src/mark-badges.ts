import { markBadge } from '../../shared/notes';
import type { Annotation, MarkBadge } from '../../shared/types';
import { lineRects, type TextView } from './view';

const SVG = 'http://www.w3.org/2000/svg';
const SIZE = 14;

/** The pictograms, drawn as strokes so that they take the badge's colour. */
const ICONS: Record<MarkBadge, string[]> = {
  note: [
    'M6 4h12a2 2 0 0 1 2 2v7l-6 6H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    'M14 19v-4a1 1 0 0 1 1-1h5',
    'M8 9h8M8 13h4',
  ],
  speech: ['M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3M9 21h6'],
};
const TITLES: Record<MarkBadge, string> = {
  note: 'Comment: show it in the sidebar',
  speech: 'Spoken comment: show it in the sidebar',
};

function icon(kind: MarkBadge): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[kind]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Takes away every badge, in whichever view it was painted. */
export function clearBadges(): void {
  for (const badge of document.querySelectorAll('.mark-badge')) badge.remove();
}

/**
 * Puts a small icon above the first line of each marked section that has a comment: a note for a
 * typed comment, a microphone for a spoken one. Marks paint with the CSS Custom Highlight API and
 * so have no element to hang an icon on; the badges are positioned in the scrolling container, where
 * they move with the text. A page that is not on screen has no ranges and so no badge yet; they are
 * made again when its text appears, as the highlights are.
 */
export function paintBadges(
  view: TextView,
  marks: readonly Annotation[],
  anchored: (mark: Annotation) => Annotation | undefined,
  onClick: (mark: Annotation) => void,
): void {
  clearBadges();
  const { container } = view;
  const box = container.getBoundingClientRect();
  for (const mark of marks) {
    const kind = markBadge(mark);
    const place = kind && anchored(mark);
    if (!kind || !place) continue;
    const range = view.domRanges(mark.page, [[place.start, place.end]])[0];
    const line = range && lineRects(range)[0];
    if (!line) continue;
    const badge = document.createElement('button');
    badge.className = 'mark-badge';
    badge.dataset.badge = kind;
    badge.dataset.color = mark.color;
    badge.dataset.id = mark.id;
    badge.title = TITLES[kind];
    badge.setAttribute('aria-label', TITLES[kind]);
    badge.style.left = `${line.left - box.left + container.scrollLeft}px`;
    badge.style.top = `${line.top - box.top + container.scrollTop - SIZE + 2}px`;
    // A click must not take away the selection the mark menu belongs to.
    badge.addEventListener('mousedown', (event) => event.preventDefault());
    badge.addEventListener('click', () => onClick(mark));
    badge.append(icon(kind));
    container.append(badge);
  }
}
