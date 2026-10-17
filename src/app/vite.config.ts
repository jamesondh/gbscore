import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The app's config lives here, not at the repo root, so vitest at the root keeps its defaults.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('.'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': here('.') } },
  build: { outDir: here('../../dist/web'), emptyOutDir: true },
  worker: { format: 'es' },
  server: { fs: { allow: [here('../..')] } },
});
