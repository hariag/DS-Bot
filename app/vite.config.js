import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The window loads the build from the app's own scheme, so asset paths stay relative.
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  base: './',
  // The marks, themes and copy come from the plugin's interface code in ../ds-bot, which
  // has no React of its own.
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: 'dist', emptyOutDir: true },
})
