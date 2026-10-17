import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import unusedImports from 'eslint-plugin-unused-imports'
import { globalIgnores } from 'eslint/config'

const legacyUncheckedFiles = [
  'src/App.tsx',
  'src/components/CashuWalletModal.tsx',
  'src/ui/calendar/EventEditModal.tsx',
  'src/ui/settings/**/*.tsx',
  'src/ui/task/EditModal.tsx',
]

const tsNocheckFiles = [
  ...legacyUncheckedFiles,
  // Chat's runtime/page moved unchanged out of the unchecked wallet modal. Type them after
  // the behaviour-preserving extraction is complete; keep the rest of src/chat checked.
  'src/chat/ChatPage.tsx',
  'src/chat/ChatRuntime.tsx',
  'src/chat/views/**/*.tsx',
  'src/hooks/wallet/**/*.{ts,tsx}',
  // Moved out of the wallet unchanged; typing them is tracked separately.
  'src/chat/hooks/**/*.{ts,tsx}',
  'src/ui/wallet/**/*.tsx',
  'src/wallet/walletModalHelpers.tsx',
]

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: {
      'react-hooks': reactHooks,
      'unused-imports': unusedImports,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'react-refresh/only-export-components': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
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
    // Legacy App/wallet extraction files are being cleaned up separately.
    // Keep hook correctness enabled for normal files, but avoid turning the
    // dependency update into a broad behavior-changing dependency-array churn.
    files: tsNocheckFiles,
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'unused-imports/no-unused-vars': 'off',
    },
  },
  {
    // Chat must keep working when the wallet is turned off and, later, deleted: nothing in
    // src/chat may import wallet, mint or Cashu code. The wallet may depend on chat, not the
    // reverse.
    files: ['src/chat/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/wallet/**',
                '**/mint/**',
                '@cashu/*',
                '**/context/walletContexts',
                '**/context/Cashu*',
                '**/context/P2PK*',
                '**/context/Nwc*',
                '**/hooks/wallet/**',
                '**/components/CashuWalletModal*',
              ],
              message: 'Chat must not depend on the wallet (being phased out). Move shared code into src/chat or a neutral module.',
            },
          ],
        },
      ],
    },
  },
  {
    files: legacyUncheckedFiles,
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
])
