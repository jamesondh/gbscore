import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The app's config lives here, not at the repo root, so vitest at the root keeps its defaults.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The commit the build is from, for the About dialog. Vercel's build may have no .git, but it names the commit.
function commit(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  root: here('.'),
  define: { __COMMIT__: JSON.stringify(commit()) },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': here('.') } },
  build: { outDir: here('../../dist/web'), emptyOutDir: true },
  worker: { format: 'es' },
  server: { fs: { allow: [here('../..')] } },
});
