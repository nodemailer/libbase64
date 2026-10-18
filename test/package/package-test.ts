import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { hasDist, root, runInConsumer } from './helpers.js';

// These tests exercise the compiled output in dist/ (built by the pretest
// script) through the package.json exports map, the same way an installed
// copy of the package is loaded. Node resolves the package name to the
// package itself when the specifier is used from inside the package.
const require = createRequire(import.meta.url);

// Non-literal specifiers keep TypeScript from resolving the built types at
// type-check time, when dist/ may not exist yet
const packageName: string = 'libbase64';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// The members of the pre-TypeScript `module.exports` object
const MEMBERS = ['Decoder', 'Encoder', 'decode', 'encode', 'wrap'];

describe('Built package', { timeout: 30 * 1000, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    it('ships both module formats with type declarations', () => {
        for (const format of ['esm', 'cjs']) {
            assert.ok(fs.existsSync(path.join(root, 'dist', format, 'libbase64.js')), format);
            assert.ok(fs.existsSync(path.join(root, 'dist', format, 'libbase64.d.ts')), format + ' type declarations');
        }
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'esm', 'package.json'), 'utf8')), { type: 'module' });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'cjs', 'package.json'), 'utf8')), { type: 'commonjs' });
    });

    it('points every exports entry at an existing file', () => {
        assert.strictEqual(pkg.exports['.'].import, './dist/esm/libbase64.js');
        assert.strictEqual(pkg.exports['.'].require, './dist/cjs/libbase64.js');
        assert.strictEqual(pkg.main, './dist/cjs/libbase64.js');
        assert.ok(fs.existsSync(path.join(root, pkg.types)), 'types entry exists');
        for (const [subpath, entry] of Object.entries(pkg.exports)) {
            if (subpath.includes('*')) {
                continue;
            }
            const targets = typeof entry === 'string' ? [entry] : Object.values(entry as Record<string, string>);
            for (const target of targets) {
                assert.ok(fs.existsSync(path.join(root, target)), subpath + ' points at a missing file ' + target);
            }
        }
    });

    it('packs the builds and the docs only', () => {
        const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
            cwd: root,
            encoding: 'utf8',
            shell: process.platform === 'win32'
        });
        assert.strictEqual(result.status, 0, result.stderr);
        const files = JSON.parse(result.stdout)[0]
            .files.map((file: { path: string }) => file.path)
            .sort();
        assert.deepStrictEqual(files, [
            'CHANGELOG.md',
            'LICENSE',
            'README.md',
            'SECURITY.md',
            'dist/cjs/libbase64.d.ts',
            'dist/cjs/libbase64.js',
            'dist/cjs/package.json',
            'dist/esm/libbase64.d.ts',
            'dist/esm/libbase64.js',
            'dist/esm/package.json',
            'package.json'
        ]);
    });

    it('has no production dependencies', () => {
        // EmailEngine bundles libbase64 with @yao-pkg/pkg, which follows the require() graph only
        assert.deepStrictEqual(Object.keys(pkg.dependencies || {}), []);
    });

    describe('CommonJS build', () => {
        it('resolves require() to the CommonJS entry point', () => {
            assert.strictEqual(require.resolve(packageName), path.join(root, 'dist', 'cjs', 'libbase64.js'));
            assert.strictEqual(require.resolve(packageName + '/lib/libbase64'), path.join(root, 'dist', 'cjs', 'libbase64.js'));
            assert.strictEqual(require.resolve(packageName + '/lib/libbase64.js'), path.join(root, 'dist', 'cjs', 'libbase64.js'));
        });

        it('returns the exports object with the same members as before', () => {
            const libbase64 = require(packageName);
            assert.deepStrictEqual(Object.keys(libbase64).sort(), MEMBERS);
            // transpiled `import libbase64 from 'libbase64'` reads .default
            assert.strictEqual(libbase64.default, libbase64);
            assert.strictEqual(require(packageName + '/lib/libbase64'), libbase64);
        });

        it('keeps the members working', async () => {
            const libbase64 = require(packageName);
            assert.strictEqual(libbase64.encode('jõgeva'), 'asO1Z2V2YQ==');
            assert.strictEqual(libbase64.decode('asO1Z2V2YQ==').toString(), 'jõgeva');
            assert.strictEqual(libbase64.wrap('asO1Z2V2asO1Z2V2asO1Z2V2YQ==', 10), 'asO1Z2V2as\r\nO1Z2V2asO1\r\nZ2V2YQ==');
            const encoder = new libbase64.Encoder({ lineLength: 4 });
            const decoder = new libbase64.Decoder();
            const output: Buffer[] = [];
            decoder.on('data', (chunk: Buffer) => output.push(chunk));
            const done = new Promise(resolve => decoder.on('end', resolve));
            encoder.pipe(decoder);
            encoder.end(Buffer.from('jõgeva'));
            await done;
            assert.strictEqual(Buffer.concat(output).toString(), 'jõgeva');
        });

        it('loads in a CommonJS application without a loader', async () => {
            const output = await runInConsumer({
                files: {
                    'app.js': `
                const libbase64 = require('libbase64');
                const { encode, Encoder } = require('libbase64');
                const deep = require('libbase64/lib/libbase64');
                const encoder = new Encoder({ lineLength: 4 });
                const chunks = [];
                encoder.on('data', chunk => chunks.push(chunk));
                encoder.on('end', () => {
                    console.log(JSON.stringify([
                        libbase64.decode('YQ==Yg==').toString(),
                        encode('jõgeva'),
                        deep === libbase64,
                        Buffer.concat(chunks).toString(),
                        require.resolve('libbase64').split(require('path').sep).slice(-3).join('/')
                    ]));
                });
                encoder.end('abcdef');
                `
                }
            });
            assert.deepStrictEqual(JSON.parse(output), ['ab', 'asO1Z2V2YQ==', true, 'YWJj\r\nZGVm', 'dist/cjs/libbase64.js']);
        });
    });

    describe('ES module build', () => {
        it('resolves import to the ES module entry point', async () => {
            const url = new URL('../../dist/esm/libbase64.js', import.meta.url).href;
            const direct = await import(url);
            const byName = await import(packageName);
            assert.strictEqual(byName.default, direct.default);
            assert.strictEqual(byName.Encoder, direct.Encoder);
        });

        it('exposes the members as named exports and as the default export', async () => {
            const mod = await import(packageName);
            assert.deepStrictEqual(Object.keys(mod.default).sort(), MEMBERS);
            for (const member of MEMBERS) {
                assert.strictEqual(mod[member], mod.default[member], member);
            }
            const deep = await import(packageName + '/lib/libbase64.js');
            assert.strictEqual(deep.default, mod.default);
        });

        it('loads in an ES module application without a loader', async () => {
            const output = await runInConsumer({
                files: {
                    'app.mjs': `
                import libbase64, { decode, wrap } from 'libbase64';
                console.log(JSON.stringify([libbase64.encode('jõgeva'), decode('YQ==Yg==').toString(), wrap('YWJjZGVm', 4), typeof libbase64.Decoder]));
                `
                }
            });
            assert.deepStrictEqual(JSON.parse(output), ['asO1Z2V2YQ==', 'ab', 'YWJj\r\nZGVm', 'function']);
        });
    });
});
