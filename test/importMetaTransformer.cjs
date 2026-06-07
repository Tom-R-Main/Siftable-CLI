/**
 * Jest transformer: make the TUI's Bun/ESM `import.meta.url` loadable under
 * ts-jest's CommonJS output, then delegate all real compilation to ts-jest.
 *
 * `sift interactive` is Bun-first and uses `import.meta.url` to locate sibling
 * assets and binaries relative to a module (audio.ts → ./assets/sounds,
 * skillsEngine.ts → ./skills, cellRender.ts → ./native/cell-render, the
 * native/*.ts FFI loaders → ./lib*.dylib). ts-jest compiles to CommonJS, where
 * `import.meta` is a syntax error ("Cannot use 'import.meta' outside a module"),
 * which makes any suite that transitively imports those modules fail to load.
 *
 * We substitute a `__filename`-derived `file://` URL before handing the source
 * to ts-jest. Under ts-jest, `__filename` is the original .ts source path, so
 * `new URL('./skills', __importMetaUrl)` resolves to exactly the same directory
 * `import.meta.url` would under Bun — relative resolution stays correct, not
 * just parseable. Only files that actually contain `import.meta.url` are touched.
 */
const tsJest = require('ts-jest').default;

const base = tsJest.createTransformer({
  tsconfig: 'tsconfig.test.json',
  diagnostics: false,
});

const SHIM = "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;\n";

function patch(src) {
  if (!src.includes('import.meta.url')) return src;
  return SHIM + src.replace(/import\.meta\.url/g, '__importMetaUrl');
}

module.exports = {
  process(src, filename, options) {
    return base.process(patch(src), filename, options);
  },
  processAsync(src, filename, options) {
    return base.processAsync(patch(src), filename, options);
  },
  getCacheKey(src, filename, options) {
    return base.getCacheKey(patch(src), filename, options);
  },
  getCacheKeyAsync(src, filename, options) {
    return base.getCacheKeyAsync(patch(src), filename, options);
  },
};
