import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resourcePaths } from '../../src/main/resources';

const appPath = join('C:', 'work', 'pdfreader');
const resourcesPath = join('C:', 'Apps', 'PDF Reader', 'resources');

describe('resourcePaths', () => {
  it('uses the project folder in development', () => {
    expect(resourcePaths({ packaged: false, appPath, resourcesPath })).toEqual({
      modelsDir: join(appPath, 'models'),
      helperScript: join(appPath, 'helper', 'xtts_helper.py'),
    });
  });

  it('uses the folder beside app.asar when packaged, never the archive itself', () => {
    const paths = resourcePaths({ packaged: true, appPath: join(resourcesPath, 'app.asar'), resourcesPath });
    expect(paths.modelsDir).toBe(join(resourcesPath, 'models'));
    expect(paths.helperScript).toBe(join(resourcesPath, 'helper', 'xtts_helper.py'));
  });

  it('lets PDFREADER_MODELS replace the models folder only', () => {
    const paths = resourcePaths({ packaged: true, appPath, resourcesPath, modelsOverride: 'D:\\models' });
    expect(paths.modelsDir).toBe('D:\\models');
    expect(paths.helperScript).toBe(join(resourcesPath, 'helper', 'xtts_helper.py'));
  });
});
