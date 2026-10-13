// Sets up the XTTS-v2 GPU voice in ./models: a Python environment and the model's weights.
//   npm run gpu-voice -- --accept-licence   install what is missing (about 7 GB of downloads)
//   npm run gpu-voice -- --check            show what is installed
// Needs a 64-bit Python 3.12 (the Windows launcher "py -3.12"), an NVIDIA GPU with about 3 GB
// free, and a network for this step only. Reading aloud afterwards is offline.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = process.env.PDFREADER_MODELS ?? join(root, 'models');
const envDir = join(modelsDir, 'xtts-env');
const weightsDir = join(modelsDir, 'xtts-v2');
const requirements = join(root, 'helper', 'xtts-requirements.txt');
const python = join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const marker = join(envDir, '.requirements');
const args = process.argv.slice(2);

const have = {
  environment:
    existsSync(python) &&
    existsSync(marker) &&
    readFileSync(marker, 'utf8') === readFileSync(requirements, 'utf8'),
  weights: existsSync(join(weightsDir, 'model.pth')),
};

if (args.includes('--check')) {
  console.log(`environment  ${have.environment ? 'installed' : 'missing  '}  ${envDir}`);
  console.log(`weights      ${have.weights ? 'installed' : 'missing  '}  ${weightsDir}`);
  process.exit(have.environment && have.weights ? 0 : 1);
}

if (!args.includes('--accept-licence')) {
  console.error(`XTTS-v2 is licensed under the Coqui Public Model License 1.0.0, which allows only
non-commercial use of the model and of what it speaks. Personal study, private entertainment and
hobby projects are named as non-commercial. Anyone who receives the model, or audio it made, must
be given the same terms: https://coqui.ai/cpml.txt (also in models/xtts-v2/LICENSE.txt afterwards).

Run again with --accept-licence to agree and install:  npm run gpu-voice -- --accept-licence`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed (${result.status})`);
}

// The versions in the requirements file were tested on 3.12 only.
const base = process.platform === 'win32' ? ['py', ['-3.12']] : ['python3.12', []];
try {
  const bits = execFileSync(base[0], [...base[1], '-c', 'import struct;print(struct.calcsize("P")*8)'], {
    encoding: 'utf8',
  }).trim();
  if (bits !== '64') throw new Error('not 64-bit');
} catch {
  console.error('A 64-bit Python 3.12 is needed ("py -3.12" on Windows, "python3.12" elsewhere).');
  process.exit(1);
}

mkdirSync(modelsDir, { recursive: true });
if (!existsSync(python)) {
  console.log(`Creating ${envDir}`);
  run(base[0], [...base[1], '-m', 'venv', envDir]);
}
if (!have.environment) {
  console.log('Installing packages (PyTorch with CUDA is about 2.5 GB)');
  run(python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements]);
  writeFileSync(marker, readFileSync(requirements, 'utf8'));
}
if (!have.weights) {
  console.log('Downloading the XTTS-v2 weights (about 1.9 GB)');
  run(python, [
    '-I',
    '-c',
    [
      'import sys',
      'from huggingface_hub import snapshot_download',
      "snapshot_download('coqui/XTTS-v2', local_dir=sys.argv[1],",
      "  allow_patterns=['config.json','model.pth','vocab.json','speakers_xtts.pth','dvae.pth','mel_stats.pth','LICENSE.txt'])",
    ].join('\n'),
    weightsDir,
  ]);
}

// A GPU that PyTorch cannot see would only show up later as a voice that never answers.
run(python, [
  '-I',
  '-c',
  'import torch; assert torch.cuda.is_available(), "PyTorch cannot see a CUDA GPU"; print("GPU:", torch.cuda.get_device_name(0))',
]);
console.log('XTTS-v2 is ready. Restart the app, then choose it under Voices.');
