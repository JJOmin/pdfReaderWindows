import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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
  // The addon loads onnxruntime (.dll, .dylib) from its own folder, which an archive cannot provide.
  asarUnpack: [
    'node_modules/sherpa-onnx-node/**',
    'node_modules/sherpa-onnx-win-x64/**',
    'node_modules/sherpa-onnx-darwin-arm64/**',
  ],
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
  // Apple Silicon runs no unsigned code, and packaging changed the app, so it is signed again: the
  // addon's libraries one by one, since --deep does not reach loose files in Resources, then the app.
  afterPack: (context) => {
    if (context.electronPlatformName !== 'darwin') return;
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const unpacked = join(app, 'Contents', 'Resources', 'app.asar.unpacked');
    const native = readdirSync(unpacked, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(dylib|node)$/u.test(file))
      .map((file) => join(unpacked, file));
    for (const file of native) execFileSync('codesign', ['--force', '--sign', '-', file]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]);
  },
  // ADR 9: Apple Silicon only, ad-hoc signed because there is no paid Apple account, not notarised.
  // The hardened runtime is off: with an ad-hoc signature it would refuse the addon's libraries.
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    artifactName: 'PDF-Reader-${version}-${arch}.${ext}',
    category: 'public.app-category.productivity',
    // Signed ad hoc in afterPack below, not by electron-builder: its signer reads every file to
    // find binaries, and an ONNX model crashed that check (isbinaryfile, "Invalid array length").
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    // Finder lists the app under Open With for PDFs; it does not become the default.
    fileAssociations: [{ ext: 'pdf', name: 'PDF document', role: 'Viewer', rank: 'Alternate' }],
    extendInfo: {
      NSMicrophoneUsageDescription:
        'PDF Reader listens while you dictate a comment, and writes it out on this computer.',
      NSLocalNetworkUsageDescription:
        'PDF Reader finds your paired phones on this network and sends them the documents you prepared.',
    },
  },
};
