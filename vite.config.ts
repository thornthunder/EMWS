import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const nodeModuleStub = fileURLToPath(new URL('./src/engine/nec2/wasm/node-module-stub.ts', import.meta.url));

export default defineConfig(({ mode }) => ({
  // Relative asset URLs: the same build works at a site root, in an IIS virtual
  // directory (https://host/emws/), or opened from any other static host.
  base: './',
  plugins: [react()],
  resolve: {
    // The tests run the engine under Node and need the real 'node:module'; browser
    // builds get a stub. See node-module-stub.ts.
    alias: mode === 'test' ? [] : [{ find: 'node:module', replacement: nodeModuleStub }],
  },
  worker: { format: 'es' as const },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
