import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const storeSelectors = [
  {
    selector: "ImportSpecifier[imported.name='useStore']",
    message:
      'Import useAppStore or useEditorStore; the legacy singleton is not a consumer API.',
  },
  {
    selector: "MemberExpression[object.name='useEditorStore']",
    message:
      'Use useEditorStoreApi() or pass an explicit PdfEditorStoreApi for imperative access.',
  },
]

// The root App / AppContent (and WorkspaceView, which renders the shell) re-render the whole tree, so it may select stable values and
// derived scalars (`s.model.pages.length`), never an object that changes on
// every edit, pointer move, or undo. Those belong in leaf controllers.
const rootRenderSelectors = [
  {
    selector:
      "FunctionDeclaration[id.name=/^(App|AppContent|WorkspaceView)$/] CallExpression[callee.name='useEditorStore'] > ArrowFunctionExpression > MemberExpression.body[property.name=/^(model|pages|selectedIds|activePageId|undoStack|redoStack|collapsedNoteIds|collapsedCalloutIds)$/]",
    message:
      'The root App must not subscribe to high-frequency editor state; select it in a leaf controller.',
  },
]

// A page merge reads the open generation and never claims one: a merge that
// claimed while it waited in its queue outranked an open the reader had
// started meanwhile, so the new document abandoned itself (a P1). The merge
// holds the workspace store, so nothing but this stops a claim creeping back.
// See src/workspace/workspaceStore.ts `Navigation`.
const mergeClaimMessage =
  'Page merges read navigation.generation and never claim or write it.'
const mergeClaimSelectors = [
  {
    selector: 'Identifier[name=/^claim(Open|Navigation|ForegroundIntent)$/]',
    message: mergeClaimMessage,
  },
  {
    selector: "CallExpression[callee.property.name=/^set(State)?$/] Property[key.name='navigation']",
    message: mergeClaimMessage,
  },
]

const tauriMessage =
  'Import Tauri APIs only inside src/platform/; call a platform helper here.'
const tauriSelectors = [
  { selector: 'ImportDeclaration[source.value=/^@tauri-apps/]', message: tauriMessage },
  { selector: 'ImportExpression[source.value=/^@tauri-apps/]', message: tauriMessage },
]

export default defineConfig([
  globalIgnores(['dist', 'src-tauri/target', 'src-tauri/gen', 'src/pdf/engine/wasm/generated']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/editor/store/store.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportSpecifier[imported.name='useStore']",
          message:
            'Import useAppStore or useEditorStore; the legacy singleton is not a consumer API.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/editor/store/store.ts', 'src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...storeSelectors],
    },
  },
  {
    // Components and hooks reach Tauri only through src/platform/, which
    // branches on IS_TAURI so the same code runs in the web build.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/editor/store/store.ts',
      'src/**/*.test.{ts,tsx}',
      'src/platform/**',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...storeSelectors, ...tauriSelectors],
    },
  },
  {
    files: ['src/workspace/merge/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...storeSelectors,
        ...tauriSelectors,
        ...mergeClaimSelectors,
      ],
    },
  },
  {
    files: ['src/App.tsx', 'src/App/render/WorkspaceView.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...storeSelectors,
        ...tauriSelectors,
        ...rootRenderSelectors,
      ],
    },
  },
  // Stage 4.1 of docs/PLAN-RUST-PDF-CORE-2026-09.md: pdf.js stays behind the
  // engine seam (src/pdf/engine/, src/pdf/render/), so moving off it is a
  // change of engine, not of every caller. Since 4.7b no reader outside it.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/**/*.test.{ts,tsx}',
      'src/pdf/engine/**',
      'src/pdf/render/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pdfjs-dist', 'pdfjs-dist/*', '**/pdf/render/pdfjs', '**/render/pdfjs'],
              message:
                'Read PDFs through the engine (src/pdf/engine/types.ts: PdfEngine, PdfDocument), not pdf.js.',
            },
          ],
        },
      ],
    },
  },
])
