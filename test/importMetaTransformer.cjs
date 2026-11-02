/**
 * Jest runtime transformer for TypeScript loaded through the CLI's CommonJS
 * test process. Authoritative typechecking is intentionally separate:
 * tsconfig.test.json owns Node16 tests and tsconfig.test.tui.json owns graphs
 * that cross into the Bun/ESM TUI.
 *
 * `sift interactive` uses `import.meta.url` to locate sibling assets and native
 * libraries. CommonJS Jest cannot parse it, so replace only that expression
 * with the equivalent URL derived from the original source filename before
 * isolated transpilation. Relative resolution stays identical.
 */
const {createHash} = require('node:crypto');
const ts = require('typescript');

const SHIM = "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;\n";
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
  sourceMap: true,
  inlineSources: true,
};

function patch(src) {
  if (!src.includes('import.meta.url')) return src;
  return SHIM + src.replace(/import\.meta\.url/g, '__importMetaUrl');
}

function transform(src, filename) {
  const result = ts.transpileModule(patch(src), {
    compilerOptions,
    fileName: filename,
    reportDiagnostics: false,
  });
  return {code: result.outputText, map: result.sourceMapText};
}

module.exports = {
  process(src, filename) {
    return transform(src, filename);
  },
  async processAsync(src, filename) {
    return transform(src, filename);
  },
  getCacheKey(src, filename, options) {
    return createHash('sha256')
      .update(ts.version)
      .update('\0')
      .update(filename)
      .update('\0')
      .update(options.configString ?? '')
      .update('\0')
      .update(patch(src))
      .digest('hex');
  },
};
