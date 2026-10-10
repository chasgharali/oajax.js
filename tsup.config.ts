import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', jquery: 'src/jquery.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    // Share one copy of the core between the two entries in CJS too, so
    // `configure()` from 'oajax.js' applies to `$oajax` from 'oajax.js/jquery'.
    splitting: true,
    sourcemap: true,
    target: 'es2020',
  },
  {
    // Script-tag build, like v1's dist/oajax.min.js.
    entry: { oajax: 'src/browser.ts' },
    format: ['iife'],
    minify: true,
    sourcemap: true,
    target: 'es2018',
    outExtension: () => ({ js: '.min.js' }),
  },
])
