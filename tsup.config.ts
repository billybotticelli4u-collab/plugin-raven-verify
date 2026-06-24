import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // @elizaos/core is provided by the host runtime — never bundle it.
  external: ['@elizaos/core'],
});
