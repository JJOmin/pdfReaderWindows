// Copies the PDF.js runtime assets (character maps, standard fonts, image decoders)
// into the renderer's public folder so the app works offline.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'pdfjs-dist');
const to = join(root, 'src', 'renderer', 'public', 'pdfjs');

if (existsSync(from)) {
  rmSync(to, { recursive: true, force: true });
  for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    if (existsSync(join(from, dir))) cpSync(join(from, dir), join(to, dir), { recursive: true });
  }
}
