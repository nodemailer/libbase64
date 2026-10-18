import { describe, it } from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hasDist, runInConsumer } from './helpers.js';

// The suite runs through tsx, which strips the types instead of checking them, and
// `npm run typecheck` checks the types in src/. These tests type-check a consumer against
// the built declarations in dist/ the way an installed copy is resolved: the package is
// linked into a temporary project so that the specifiers go through the package.json
// exports map.
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

// An ES module consumer: the default export object, the named exports, the option types and
// the deep import
const esmConsumer = `
import { Buffer } from 'node:buffer';
import libbase64, { encode, decode, wrap, Encoder, Decoder } from 'libbase64';
import type { EncoderOptions, DecoderOptions } from 'libbase64';
import deep from 'libbase64/lib/libbase64';

const options: EncoderOptions = { lineLength: 76, skipStartBytes: 0, limitOutputBytes: 10, startPadding: '' };
const decoderOptions: DecoderOptions = {};
const text: string = libbase64.encode('a') + encode(Buffer.from('a')) + encode(new Uint8Array([1])) + wrap('YWJj', 2) + deep.wrap('YWJj');
const bytes: Buffer = decode('YWJj');
const encoder: Encoder = new libbase64.Encoder(options);
const unwrapped = new Encoder({ lineLength: false });
const decoder: Decoder = new Decoder(decoderOptions);
const counted: number = encoder.inputBytes + decoder.outputBytes + unwrapped.outputBytes;
encoder.pipe(decoder);

export { text, bytes, counted };
`;

// A TypeScript CommonJS consumer, in every import form
const cjsConsumer = `
import libbase64 = require('libbase64');
import * as star from 'libbase64';
import defaultImport from 'libbase64';
import { Decoder } from 'libbase64';
import deep = require('libbase64/lib/libbase64');

const options: libbase64.EncoderOptions = { lineLength: 20 };
const encoder = new libbase64.Encoder(options);
const decoder: Decoder = new star.Decoder();
const text: string = star.encode('a') + defaultImport.encode('a') + deep.wrap('YWJj', 2);
const bytes: Buffer = defaultImport.decode('YWJj');
encoder.pipe(decoder);

export { text, bytes };
`;

// A CommonJS JavaScript consumer checked with checkJs
const jsConsumer = `
const libbase64 = require('libbase64');

/** @type {import('libbase64').EncoderOptions} */
const options = { lineLength: 76, limitOutbutBytes: 10 };
const encoder = new libbase64.Encoder(options);

/** @type {string} */
const text = libbase64.encode('a') + libbase64.wrap(libbase64.encode(Buffer.from('a')));
encoder.pipe(new libbase64.Decoder());

module.exports = { text, decoded: libbase64.decode(text) };
`;

const node16 = { module: 'node16', moduleResolution: 'node16' };

// Type-checks one consumer source against the built declarations in dist/ the way an
// installed copy is resolved, through the package.json exports map
const typeCheckConsumer = async (source: string, file: string, compilerOptions: { [key: string]: unknown }, type?: string): Promise<void> => {
    const tsconfig = {
        compilerOptions: {
            target: 'ES2022',
            lib: ['ES2023'],
            types: ['node'],
            strict: true,
            exactOptionalPropertyTypes: true,
            noEmit: true,
            skipLibCheck: false,
            esModuleInterop: true,
            ...compilerOptions
        },
        include: [file]
    };
    await runInConsumer({
        files: { [file]: source, 'tsconfig.json': JSON.stringify(tsconfig) },
        type,
        args: dir => [tsc, '-p', path.join(dir, 'tsconfig.json')]
    });
};

describe('Built package types', { timeout: 120 * 1000, concurrency: true, skip: hasDist ? false : 'dist/ is not built, run npm run build first' }, () => {
    it('type-checks an ES module consumer with node16 resolution', async () => {
        await typeCheckConsumer(esmConsumer, 'consumer.ts', node16, 'module');
    });

    it('type-checks an ES module consumer with bundler resolution', async () => {
        await typeCheckConsumer(esmConsumer, 'consumer.ts', { module: 'esnext', moduleResolution: 'bundler' }, 'module');
    });

    it('type-checks a CommonJS consumer', async () => {
        // no "type": "module" in the consumer package, so the file is a CommonJS module
        await typeCheckConsumer(cjsConsumer, 'consumer.ts', node16);
    });

    it('type-checks a CommonJS consumer with the legacy node10 resolution', async () => {
        // node10 ignores the exports map, the types and typesVersions fields resolve the declarations
        await typeCheckConsumer(cjsConsumer, 'consumer.ts', { module: 'commonjs', moduleResolution: 'node10', ignoreDeprecations: '6.0' });
    });

    it('type-checks a JavaScript consumer with checkJs', async () => {
        await typeCheckConsumer(jsConsumer, 'consumer.js', { ...node16, allowJs: true, checkJs: true });
    });
});
