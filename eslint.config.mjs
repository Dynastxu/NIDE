import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintReact from '@eslint-react/eslint-plugin'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintReact.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
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
