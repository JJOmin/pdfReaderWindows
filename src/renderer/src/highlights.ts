/**
 * Paints a named set of ranges with the CSS Custom Highlight API. The colours live in
 * style.css under ::highlight(name). A higher priority paints on top.
 */
export function paint(name: string, ranges: Range[], priority = 0): void {
  if (ranges.length === 0) {
    CSS.highlights.delete(name);
    return;
  }
  const highlight = new Highlight(...ranges);
  highlight.priority = priority;
  CSS.highlights.set(name, highlight);
}
