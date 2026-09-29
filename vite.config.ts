import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const api = `http://${cfg.server.host}:${cfg.server.port}`;

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: cfg.web.port,
    strictPort: true,
    proxy: { '^/api/': { target: api, ws: true, changeOrigin: false } },
  },
});
