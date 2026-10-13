import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/', 'node_modules/', 'models/', 'src/renderer/public/', 'test-results/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // Indexed access is checked by the compiler; `!` marks the places proven safe.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['scripts/**', '.claude/hooks/**'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' } },
  },
);
