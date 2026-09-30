import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const backend = process.env.TEXCOLLAB_BACKEND ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the SPA runs on Vite and proxies API/WebSocket traffic to the app.
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/collab': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
