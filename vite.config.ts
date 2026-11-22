import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Silero VAD (шумоподавление слуха Джарвиса, src/lib/denoise.ts) грузит worklet, модель и среду ONNX
// по постоянному адресу /vad/… — отдаём их туда прямо из node_modules: в разработке — с диска, в сборке — в dist/vad.
const VAD_FILES: Record<string, string> = {
  'vad.worklet.bundle.min.js': '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
  'silero_vad_v5.onnx': '@ricky0123/vad-web/dist/silero_vad_v5.onnx',
  'ort-wasm-simd-threaded.mjs': 'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm': 'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
};
const vadFile = (rel: string) => fileURLToPath(new URL(`./node_modules/${rel}`, import.meta.url));
const vadType = (name: string) => (name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'text/javascript' : 'application/octet-stream');

function vadAssets(): Plugin {
  return {
    name: 'radar-vad-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.startsWith('/vad/') ? decodeURIComponent(req.url.slice(5).split('?')[0]) : '';
        const rel = VAD_FILES[name];
        if (!rel) return next();
        res.setHeader('Content-Type', vadType(name));
        fs.createReadStream(vadFile(rel)).pipe(res);
      });
    },
    generateBundle() {
      for (const [name, rel] of Object.entries(VAD_FILES)) this.emitFile({ type: 'asset', fileName: `vad/${name}`, source: fs.readFileSync(vadFile(rel)) });
    },
  };
}

// Отдельного dev-сервера Vite нет: server/index.ts поднимает Vite в middleware-режиме,
// поэтому API, поток SSE и фронтенд живут на одном порту.
export default defineConfig({
  plugins: [react(), vadAssets()],
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
