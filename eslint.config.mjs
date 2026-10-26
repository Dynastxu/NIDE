import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintReact from '@eslint-react/eslint-plugin'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/.nide-dev', '**/.nide-dist'] },
  tseslint.configs.recommended,
  eslintReact.configs.recommended,
  {
    // `.mts` = 显式 ESM 的 TypeScript：构建脚本用它，Node 才不因为根 package.json
    // 没有 `type: module` 而多打一条「重解析为 ESM」的警告。它同样要过 lint。
    files: ['**/*.{ts,tsx,mts}'],
    plugins: {
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactRefresh.configs.vite.rules
    },
    settings: {
      'react-x': {
        version: 'detect'
      }
    }
  },
  eslintConfigPrettier
)
