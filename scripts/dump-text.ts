// Prints what the reader would speak for a PDF, one utterance per line, without the app.
// Use it to judge text detection on a real document:
//   npm run dump -- paper.pdf            every page
//   npm run dump -- paper.pdf 3          page 3 only
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TEXT_CONTENT_OPTIONS, toRawItems } from '../src/shared/items.ts';
import { guessLang } from '../src/shared/language.ts';
import { layoutPage, type Block } from '../src/shared/layout.ts';
import { buildUtterances } from '../src/shared/utterances.ts';

const [file, onlyPage] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run dump -- <file.pdf> [page]');
  process.exit(1);
}

const task = getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 });
const doc = await task.promise;
const pages: Block[][] = [];
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n);
  const content = await page.getTextContent(TEXT_CONTENT_OPTIONS);
  const [, bottom = 0, , top = 0] = page.view;
  pages.push(layoutPage(toRawItems(content.items, bottom), top - bottom));
}
const lang = guessLang(
  pages
    .slice(0, 5)
    .flat()
    .map((b) => b.text)
    .join(' '),
).lang;
console.log(`# ${file}: ${doc.numPages} pages, document language ${lang}`);
pages.forEach((blocks, i) => {
  if (onlyPage && Number(onlyPage) !== i + 1) return;
  console.log(`\n## Page ${i + 1}`);
  for (const u of buildUtterances(blocks, i + 1, lang)) {
    console.log(`[${u.role.padEnd(7)} ${u.lang}] ${u.spoken}`);
  }
});
await task.destroy();
