// Builds the test PDF by printing HTML with Electron: npm run fixtures
// A generated file keeps the tests free of third-party documents.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');

const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 25mm 22mm; }
  body { font: 11pt/1.45 Georgia, serif; hyphens: auto; text-align: justify; }
  h1 { font: bold 20pt Arial, sans-serif; text-align: left; }
  h2 { font: bold 13pt Arial, sans-serif; text-align: left; margin-top: 1.4em; }
  .columns { columns: 2; column-gap: 9mm; }
  .break { break-before: page; }
</style></head><body>
<h1>Vorlesen wissenschaftlicher Texte</h1>
<p>Dieser Text prüft, ob das Programm deutsche und englische Sätze richtig erkennt. Die
Verarbeitung erfolgt vollständig lokal auf dem eigenen Rechner [1]. Das gilt z. B. für die
Sprachsynthese und für die Ausrichtung der einzelnen Wörter.</p>
<p>Die Autoren fassen ihr Ergebnis so zusammen: The proposed method is simple and it does not
need any training data at all. Diese Aussage wird im nächsten Abschnitt genauer untersucht.</p>
<h2>1 Zitate und Hervorhebungen</h2>
<p>Ein bekannter Satz lautet: „Der Mensch ist nur da ganz Mensch, wo er spielt.“ Danach folgt
wieder gewöhnlicher Text, der mit der Hauptstimme gelesen werden soll [2, 3].</p>
<h2 class="break">2 Zweispaltiger Abschnitt</h2>
<div class="columns"><p>Die linke Spalte enthält mehrere Zeilen Text, damit die Reihenfolge der
Spalten geprüft werden kann. Wissenschaftliche Veröffentlichungen verwenden diese Anordnung
sehr häufig, und die Silbentrennung am Zeilenende muss dabei rückgängig gemacht werden.</p>
<p>Die rechte Spalte beginnt weiter oben auf der Seite als das Ende der linken Spalte. This
paragraph ends with an English sentence that the English voice should read. Damit endet das
Dokument.</p></div>
</body></html>`;

// Electron holds back "ready" until this module has loaded, so a top-level await on it never returns.
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const pdf = await window.webContents.printToPDF({
    pageSize: 'A4',
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate:
      '<div style="font-size:8pt;width:100%;text-align:center"><span class="pageNumber"></span></div>',
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'sample.pdf'), pdf);
  console.log(`Wrote ${join(out, 'sample.pdf')}`);
  app.quit();
});
