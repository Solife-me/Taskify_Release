import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import unusedImports from 'eslint-plugin-unused-imports'
import { globalIgnores } from 'eslint/config'

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    plugins: {
      'unused-imports': unusedImports,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'react-refresh/only-export-components': 'off',
      // Defer unused-imports detection to the dedicated plugin which has an
      // autofix; keep `no-unused-vars` for non-import locals only. Conventional
      // opt-out everywhere: prefix the name with `_`.
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Files marked `// @ts-nocheck` are slated for the App.tsx-extraction
    // refactor (audit doc item #10). Until then, suppress lint complaints
    // about unused dead code and the ts-nocheck directive itself —
    // chasing those down piecemeal in 21k-line files isn't useful.
    files: [
      'src/App.tsx',
      'src/components/CashuWalletModal.tsx',
      'src/ui/calendar/EventEditModal.tsx',
      'src/ui/settings/BackupSection.tsx',
      'src/ui/settings/BibleSection.tsx',
      'src/ui/settings/BoardsSection.tsx',
      'src/ui/settings/FileServersSection.tsx',
      'src/ui/settings/ManageBoardModal.tsx',
      'src/ui/settings/NostrSection.tsx',
      'src/ui/settings/PushSection.tsx',
      'src/ui/settings/SettingsModal.tsx',
      'src/ui/settings/ViewSection.tsx',
      'src/ui/settings/WalletSection.tsx',
      'src/ui/task/EditModal.tsx',
    ],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      'unused-imports/no-unused-vars': 'off',
    },
  },
])
