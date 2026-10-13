import { join } from 'node:path';

export interface ResourceInputs {
  /** `app.isPackaged`. */
  packaged: boolean;
  /** `app.getAppPath()`: the project folder in development, the app.asar when packaged. */
  appPath: string;
  /** `process.resourcesPath`: the folder next to app.asar in an installed app. */
  resourcesPath: string;
  /** PDFREADER_MODELS: lets a test or a developer point at another models folder. */
  modelsOverride?: string;
}

/**
 * Where the speech models and the GPU voice's helper script are. Both live outside app.asar when
 * packaged: Python cannot read a script out of an archive, and the models are bundled as plain
 * files by electron-builder.config.mjs.
 */
export function resourcePaths(input: ResourceInputs): { modelsDir: string; helperScript: string } {
  const base = input.packaged ? input.resourcesPath : input.appPath;
  return {
    modelsDir: input.modelsOverride ?? join(base, 'models'),
    helperScript: join(base, 'helper', 'xtts_helper.py'),
  };
}
