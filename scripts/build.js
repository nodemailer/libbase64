// Builds the package.
//
// 1. Compiles src/ twice with tsc: once as ES modules into dist/esm and once as
//    CommonJS into dist/cjs. Each output directory gets its own package.json
//    that pins the module format.
// 2. Rewrites the CommonJS output so that `require()` returns the same shape
//    the pre-TypeScript CommonJS sources had, see applyCjsInterop.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = require.resolve('typescript/bin/tsc');

function runTsc(project, ...args) {
    const result = spawnSync(process.execPath, [tsc, '-p', project, ...args], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

function listFiles(dir, ext) {
    return fs
        .readdirSync(dir, { recursive: true })
        .filter(name => name.endsWith(ext))
        .map(name => path.join(dir, name));
}

// How the CommonJS output of every module with a default export is rewritten, so that
// `require()` returns the shape the pre-TypeScript CommonJS sources had
//
// - libbase64.js used to be `module.exports = { encode, decode, wrap, Encoder, Decoder }`. It keeps
//   its named exports, and the default export (the same members as one object, for
//   `import libbase64 from 'libbase64'`) is the exports object itself. The alias is non-enumerable
//   so that the enumerable keys of the module stay the five members
const CJS_SHIMS = {
    'libbase64.js': "Object.defineProperty(exports, 'default', { value: exports, enumerable: false, writable: true, configurable: true });\n"
};

// tsc emits `exports.default = X` for `export default X`. A module with a default export that
// is not listed above fails the build, its CommonJS shape has to be decided explicitly
function applyCjsInterop(dir) {
    for (const file of listFiles(dir, '.js')) {
        const source = fs.readFileSync(file, 'utf8');
        if (!/\bexports\.default\s*=/.test(source)) {
            continue;
        }
        const name = path.relative(dir, file);
        if (!Object.hasOwn(CJS_SHIMS, name)) {
            throw new Error(name + ' has a default export, list its CommonJS shape in CJS_SHIMS in scripts/build.js');
        }
        fs.writeFileSync(file, source + CJS_SHIMS[name]);
    }
}

function build() {
    fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

    runTsc('tsconfig.esm.json');
    // The ES module compile has already type-checked the same sources
    runTsc('tsconfig.cjs.json', '--noCheck');

    fs.writeFileSync(path.join(root, 'dist', 'esm', 'package.json'), JSON.stringify({ type: 'module' }, null, 4) + '\n');
    fs.writeFileSync(path.join(root, 'dist', 'cjs', 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 4) + '\n');

    applyCjsInterop(path.join(root, 'dist', 'cjs'));
}

build();
