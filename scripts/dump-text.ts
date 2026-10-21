// Prints what the reader would speak for a PDF, one utterance per line, without the app.
// Use it to judge text detection on a real document:
//   npm run dump -- paper.pdf            every page
//   npm run dump -- paper.pdf 3          page 3 only
//   npm run dump -- paper.pdf --words    each page's words and hash as JSON, as the phone library
//                                        compares them (ADR 7). The phone's golden test uses it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { TEXT_CONTENT_OPTIONS, toRawItems } from '../src/shared/items.ts';
import { guessLang } from '../src/shared/language.ts';
import { layoutPage, type Block } from '../src/shared/layout.ts';
import { pageWords } from '../src/shared/phone-library.ts';
import { buildUtterances } from '../src/shared/utterances.ts';

const args = process.argv.slice(2);
const wordsOnly = args.includes('--words');
const [file, onlyPage] = args.filter((a) => a !== '--words');
if (!file) {
  console.error('Usage: npm run dump -- <file.pdf> [page] [--words]');
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
if (wordsOnly) {
  const result = pages
    .map((blocks, i) => {
      const words = pageWords(buildUtterances(blocks, i + 1, lang));
      const wordsHash = createHash('sha256').update(words.join(' ')).digest('hex');
      return { page: i + 1, wordCount: words.length, wordsHash, words };
    })
    .filter(({ page }) => !onlyPage || Number(onlyPage) === page);
  console.log(JSON.stringify({ file: basename(file), pages: result }, null, 2));
  await task.destroy();
  process.exit(0);
}
console.log(`# ${file}: ${doc.numPages} pages, document language ${lang}`);
pages.forEach((blocks, i) => {
  if (onlyPage && Number(onlyPage) !== i + 1) return;
  console.log(`\n## Page ${i + 1}`);
  for (const u of buildUtterances(blocks, i + 1, lang)) {
    console.log(`[${u.role.padEnd(7)} ${u.lang}] ${u.spoken}`);
  }
});
await task.destroy();
