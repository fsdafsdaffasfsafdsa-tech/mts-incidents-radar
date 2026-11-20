import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Отдельного dev-сервера Vite нет: server/index.ts поднимает Vite в middleware-режиме,
// поэтому API, поток SSE и фронтенд живут на одном порту.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
