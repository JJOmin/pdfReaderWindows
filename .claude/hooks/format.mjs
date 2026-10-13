// PostToolUse hook: formats the file Claude just wrote or edited with Prettier.
// Claude Code passes the tool call as JSON on stdin. Failures are silent by design:
// a formatter problem must never block an edit. `npm run check` catches what slips through.
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { text } from 'node:stream/consumers';

try {
  const call = JSON.parse(await text(process.stdin));
  const file = call.tool_response?.filePath ?? call.tool_input?.file_path;
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  if (file && !relative(root, resolve(file)).startsWith('..')) {
    const prettier = await import('prettier');
    const info = await prettier.getFileInfo(file, { ignorePath: resolve(root, '.prettierignore') });
    if (info.inferredParser && !info.ignored) {
      const source = await readFile(file, 'utf8');
      const options = await prettier.resolveConfig(file);
      const formatted = await prettier.format(source, { ...options, filepath: file });
      if (formatted !== source) await writeFile(file, formatted);
    }
  }
} catch {
  // See the note at the top.
}
