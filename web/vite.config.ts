/// <reference types="vitest/config" />
import preact from '@preact/preset-vite';
import type { ProxyOptions } from 'vite';
import { defineConfig, loadEnv } from 'vite';
import { proxiedOrigin } from './vite.proxy.ts';

function proxyTo(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (proxyReq, req) => {
        const origin = proxiedOrigin(req.headers.origin, target);
        if (origin !== undefined) proxyReq.setHeader('origin', origin);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // The Go server (the phase 1 stub before the real server exists).
  const serverTarget = env.VITE_SERVER_TARGET || 'http://localhost:8234';
  // /api/v1 may point at the upstream UI (http://localhost:8233) for read-only browsing.
  const apiTarget = env.VITE_API_TARGET || serverTarget;

  return {
    plugins: [preact()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api/x': proxyTo(serverTarget),
        '/auth': proxyTo(serverTarget),
        '/api/v1': proxyTo(apiTarget),
        '/healthz': proxyTo(serverTarget),
        '/readyz': proxyTo(serverTarget),
      },
    },
    build: {
      target: 'es2022',
      manifest: true,
      sourcemap: false,
      modulePreload: { polyfill: false },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', '*.test.ts'],
    },
  };
});
