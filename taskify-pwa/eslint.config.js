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

// Wallet code (being phased out). Chat and tasks must not import it, so the wallet can be turned
// off and later deleted; the wallet may import them.
const walletModules = [
  '**/wallet/**',
  '**/mint/**',
  '@cashu/*',
  '**/context/walletContexts',
  '**/context/Cashu*',
  '**/context/P2PK*',
  '**/context/Nwc*',
  '**/hooks/wallet/**',
  '**/components/CashuWalletModal*',
  '**/components/EcashGlyph*',
  '**/ui/bounty/**',
  '**/ui/wallet/**',
]

const tsNocheckFiles = [
  ...legacyUncheckedFiles,
  // Legacy wallet code (being phased out). Chat is fully type-checked and must stay so.
  'src/hooks/wallet/**/*.{ts,tsx}',
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
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='isoDatePart'] > CallExpression.arguments[callee.property.name='toISOString'][callee.object.type='NewExpression'][callee.object.arguments.length=0]",
          message: "Use todayDateKey() from taskify-core for today's local date.",
        },
      ],
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
              group: walletModules,
              message: 'Chat must not depend on the wallet (being phased out). Move shared code into src/chat or a neutral module.',
            },
          ],
        },
      ],
    },
  },
  {
    // Tasks, boards, events, Upcoming and printing work with the wallet off. Bounty editing is
    // wallet code the task editor receives through its bounty slot (ui/task/taskBountyExtension).
    files: [
      'src/ui/task/**/*.{ts,tsx}',
      'src/ui/board/**/*.{ts,tsx}',
      'src/ui/calendar/**/*.{ts,tsx}',
      'src/ui/upcoming/**/*.{ts,tsx}',
      'src/ui/print/**/*.{ts,tsx}',
      'src/domains/tasks/**/*.{ts,tsx}',
      'src/domains/calendar/**/*.{ts,tsx}',
      'src/domains/upcoming/**/*.{ts,tsx}',
      // The inbox and shared plumbing outlive the wallet.
      'src/domains/inbox/**/*.{ts,tsx}',
      'src/lib/**/*.{ts,tsx}',
      'src/identity/**/*.{ts,tsx}',
      'src/routing/**/*.{ts,tsx}',
      'src/onboarding/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: walletModules,
              message: 'Tasks must not depend on the wallet (being phased out). Use the bounty slot or a neutral module.',
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
