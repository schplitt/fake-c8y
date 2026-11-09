import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: './src/index.ts',
    realtime: './src/realtime-entry.ts',
  },
  target: ['es2024'],
  // no Node built-ins: the fake runs in any runtime with fetch types
  platform: 'neutral',
  format: 'esm',
  fixedExtension: true,
  clean: true,
  dts: true,
  outDir: './dist',
})
