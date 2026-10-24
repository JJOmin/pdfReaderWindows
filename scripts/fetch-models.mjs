// Downloads and unpacks speech models into ./models.
//   npm run models            fetch every recommended model that is missing
//   npm run models -- pocket  fetch the named models
//   npm run models -- --list  show what is installed
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { retry } from '../src/shared/retry.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = join(root, 'models');
const catalog = JSON.parse(readFileSync(join(root, 'models.json'), 'utf8'));
const args = process.argv.slice(2);

if (args.includes('--list')) {
  for (const m of catalog) {
    const state = existsSync(join(modelsDir, m.dir)) ? 'installed' : 'missing  ';
    console.log(`${state}  ${m.id.padEnd(16)} ${String(m.sizeMb).padStart(4)} MB  ${m.license}`);
  }
  process.exit(0);
}

const wanted =
  args.length > 0 ? catalog.filter((m) => args.includes(m.id)) : catalog.filter((m) => m.recommended);
const unknown = args.filter((a) => !catalog.some((m) => m.id === a));
if (unknown.length > 0) {
  console.error(`Unknown model: ${unknown.join(', ')}. Known: ${catalog.map((m) => m.id).join(', ')}`);
  process.exit(1);
}

mkdirSync(modelsDir, { recursive: true });
for (const model of wanted) {
  if (existsSync(join(modelsDir, model.dir))) {
    console.log(`${model.id}: already installed`);
    continue;
  }
  console.log(`${model.id}: downloading ${model.sizeMb} MB`);
  const archive = join(modelsDir, `${model.dir}.tar.bz2`);
  // A download of hundreds of megabytes is cut off now and then, most often on a build server: it is
  // tried again, from the start, a few times before it counts as failed.
  await retry(
    async () => {
      const response = await fetch(model.url);
      if (!response.ok || !response.body) throw new Error(`${model.url}: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
      // Windows 10 and later ship bsdtar, which reads bzip2; Node has no bzip2 of its own.
      // A relative archive name keeps GNU tar from reading "C:" as a remote host.
      execFileSync('tar', ['-xjf', `${model.dir}.tar.bz2`], { cwd: modelsDir, stdio: 'inherit' });
    },
    {
      attempts: 4,
      delayMs: 5000,
      onRetry: (error, attempt) => {
        console.warn(
          `${model.id}: try ${attempt} failed (${error?.cause?.message ?? error?.message}); trying again`,
        );
        // Neither half a download nor half an unpacked model may be taken for a whole one.
        rmSync(archive, { force: true });
        rmSync(join(modelsDir, model.dir), { recursive: true, force: true });
      },
    },
  );
  rmSync(archive, { force: true });
  console.log(`${model.id}: installed`);
}
