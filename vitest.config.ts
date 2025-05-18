import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Include test files
    include: ['**/*.{test,spec}.{js,ts}'],
    // Exclude node_modules
    exclude: ['node_modules'],
    // Enable globals
    globals: true,
    // Environment
    environment: 'node',
    // TypeScript support
    typecheck: {
      tsconfig: './tsconfig.json'
    }
  }
})