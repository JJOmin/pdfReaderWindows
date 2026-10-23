import { FuseV1Options } from '@electron/fuses';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the packaging config is a plain .mjs file without types
import config, { fuses } from '../../electron-builder.config.mjs';

// The switches set in the Electron program when the app is packed (SECURITY.md). A test, so that
// loosening one is a decision someone makes on purpose and not an edit nobody noticed.
describe('the packaged app’s fuses', () => {
  it('cannot be run as Node, by variable or by flag', () => {
    expect(fuses[FuseV1Options.RunAsNode]).toBe(false);
    expect(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
    expect(fuses[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
  });

  it('loads the app from its archive only, and gives file: pages no extra power', () => {
    expect(fuses[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
    expect(fuses[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(false);
  });

  it('is applied before the Mac signature, by the packaging step itself', async () => {
    expect(String(config.afterPack)).toContain('addElectronFuses');
    expect(config.electronFuses).toBeUndefined();
  });
});

describe('the product’s name', () => {
  it('is Easy Reader, and its id is the one the installed app has', () => {
    expect(config.productName).toBe('Easy Reader');
    expect(config.appId).toBe('io.github.jjomin.pdfreader');
  });
});
