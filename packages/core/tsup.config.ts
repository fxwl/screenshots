import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  treeshake: true,
  format: ['cjs', 'esm'],
  dts: true,
  external: ['chrome'],
});
