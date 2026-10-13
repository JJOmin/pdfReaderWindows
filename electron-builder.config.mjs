import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const catalog = JSON.parse(readFileSync(join(import.meta.dirname, 'models.json'), 'utf8'));

// The installer carries the catalog's recommended models, so a fresh install reads aloud at once.
// Pocket TTS is not recommended and stays out. The GPU voice is a 7 GB Python setup and is not
// shipped; ADR 6 has the reasons.
const bundledModels = catalog
  .filter((model) => model.recommended)
  .map((model) => ({
    from: `models/${model.dir}`,
    to: `models/${model.dir}`,
    // The recogniser's sample clips are only for trying it out.
    filter: ['**/*', '!test_wavs/**'],
  }));

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'io.github.jjomin.pdfreader',
  productName: 'PDF Reader',
  directories: { output: 'dist' },
  artifactName: 'PDF-Reader-${version}-setup.${ext}',
  // Only the built app and package.json go into app.asar; production dependencies are added.
  files: ['out/**', 'package.json'],
  // The addon loads onnxruntime.dll from its own folder, which an archive cannot provide.
  asarUnpack: ['node_modules/sherpa-onnx-node/**', 'node_modules/sherpa-onnx-win-x64/**'],
  extraResources: [
    ...bundledModels,
    { from: 'helper/xtts_helper.py', to: 'helper/xtts_helper.py' },
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ],
  // sherpa-onnx ships prebuilt binaries; there is nothing to compile.
  npmRebuild: false,
  win: { target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
};
