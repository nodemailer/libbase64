/* eslint-disable no-bitwise -- the reference codec below works on bit groups */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Writable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fc from 'fast-check';
import { encode, decode, wrap, Encoder, Decoder } from '../src/libbase64.js';

// Property based tests: fast-check generates inputs, checks every property against an independent
// reference implementation of RFC 4648 written below, and shrinks a failing input to a minimal one.
// FC_NUM_RUNS sets the number of inputs per property (`npm run test:fuzz` runs many more than the
// default suite), FC_SEED replays a failing run with the seed fast-check printed for it. Shrinking a
// failure found in a large input can run for a very long time and use gigabytes of memory, so a
// property stops after 30 seconds and reports the failure shrunk as far as it got by then
const numRuns = Number(process.env.FC_NUM_RUNS) || 200;
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const params = { numRuns, interruptAfterTimeLimit: 30 * 1000, ...(seed !== undefined ? { seed } : {}) };
const timeout = Math.max(60 * 1000, numRuns * 100);

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Reference encoder, bit by bit
const refEncode = (data: Uint8Array): string => {
    let out = '';
    for (let i = 0; i < data.length; i += 3) {
        const n = (data[i] << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
        const chars = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63].map(c => ALPHABET[c]);
        const used = Math.min(data.length - i, 3) + 1;
        out += chars.slice(0, used).join('') + '='.repeat(4 - used);
    }
    return out;
};

// Reference decoder with the semantics of decode(): characters outside of the base64 alphabet (the
// URL safe "-" and "_" included, which Buffer accepts) are skipped, every "=" ends a segment, and
// every segment is decoded on its own, a trailing single character carries no full byte
const refDecode = (str: string): Buffer => {
    const out: number[] = [];
    for (const segment of str.split('=')) {
        let bits = 0;
        let count = 0;
        for (const char of segment) {
            let value = ALPHABET.indexOf(char);
            if (char === '-') {
                value = 62;
            } else if (char === '_') {
                value = 63;
            }
            if (value < 0) {
                continue;
            }
            bits = ((bits << 6) | value) & 0xffffff;
            count += 6;
            if (count >= 8) {
                count -= 8;
                out.push((bits >> count) & 0xff);
            }
        }
    }
    return Buffer.from(out);
};

// Reference line wrapping for plain base64 strings
const refWrap = (str: string, lineLength: number): string => {
    const lines: string[] = [];
    for (let pos = 0; pos < str.length; pos += lineLength) {
        lines.push(str.slice(pos, pos + lineLength));
    }
    return lines.join('\r\n');
};

// Writes the input in pieces of the given sizes, used in turn, and collects the output
const runStream = (stream: Transform, input: Buffer, chunkSizes: number[]): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const output: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => output.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(output)));
        stream.on('error', reject);
        for (let pos = 0, i = 0; pos < input.length; i++) {
            const size = chunkSizes[i % chunkSizes.length];
            stream.write(input.subarray(pos, pos + size));
            pos += size;
        }
        stream.end();
    });

// fast-check keeps generated values small by default (byte arrays of up to 10 bytes, less than one
// line of base64), every size is mixed in so that inputs span many lines and chunks as well
type Size = 'small' | 'medium' | 'large';
const sized = <T>(make: (size: Size) => fc.Arbitrary<T>): fc.Arbitrary<T> => fc.oneof(make('small'), make('medium'), make('large'));

const bytes = sized(size => fc.uint8Array({ maxLength: 4000, size }));
const chunkSizes = fc.array(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 8 });
const lineLength = fc.integer({ min: 1, max: 200 });

// Base64 looking text: mostly alphabet characters, with padding runs, line breaks, other ASCII and
// 8-bit bytes mixed in. As a latin1 string every byte is one character. `urlSafe` adds the "-" and "_"
// of the URL safe alphabet, which decode() reads and the Decoder stream skips
const encodedLike = (urlSafe: boolean) =>
    sized(size =>
        fc.array(
            fc.oneof(
                { weight: 10, arbitrary: fc.constantFrom(...(urlSafe ? ALPHABET + '-_' : ALPHABET)) },
                { weight: 2, arbitrary: fc.constantFrom('=', '==', '\r\n', ' ', '\t') },
                {
                    weight: 1,
                    arbitrary: fc
                        .integer({ min: 0, max: 255 })
                        .map(code => String.fromCharCode(code))
                        .filter(char => urlSafe || (char !== '-' && char !== '_'))
                }
            ),
            { maxLength: 2000, size }
        )
    ).map(parts => parts.join(''));

describe('libbase64 properties', () => {
    it('encode matches the reference encoder and Buffer', () => {
        fc.assert(
            fc.property(bytes, data => {
                const encoded = encode(data);
                assert.strictEqual(encoded, refEncode(data));
                assert.strictEqual(encoded, Buffer.from(data).toString('base64'));
                assert.strictEqual(encode(Buffer.from(data)), encoded);
            }),
            params
        );
    });

    it('encode of a string encodes its UTF-8 bytes', () => {
        fc.assert(
            fc.property(fc.string({ unit: 'binary', maxLength: 300 }), str => {
                assert.strictEqual(encode(str), refEncode(Buffer.from(str, 'utf-8')));
            }),
            params
        );
    });

    it('decode reverses encode, also for wrapped and separately padded parts', () => {
        fc.assert(
            fc.property(fc.array(bytes, { maxLength: 5, size: 'small' }), lineLength, (parts, length) => {
                const data = Buffer.concat(parts);
                assert.ok(decode(encode(data)).equals(data));
                assert.ok(decode(wrap(encode(data), length)).equals(data));
                assert.ok(decode(parts.map(part => encode(part)).join('\r\n')).equals(data));
            }),
            params
        );
    });

    it('decode matches the reference decoder for any input', () => {
        fc.assert(
            fc.property(fc.oneof(encodedLike(true), fc.string({ unit: 'binary', maxLength: 200 })), str => {
                assert.deepStrictEqual(decode(str), refDecode(str));
            }),
            params
        );
    });

    it('the Decoder stream matches decode for any input and any chunking', { timeout }, async () => {
        await fc.assert(
            fc.asyncProperty(encodedLike(false), chunkSizes, async (str, sizes) => {
                const input = Buffer.from(str, 'latin1');
                const output = await runStream(new Decoder(), input, sizes);
                assert.deepStrictEqual(output, refDecode(str));
                assert.deepStrictEqual(output, decode(str));
            }),
            params
        );
    });

    it('the Encoder stream matches wrap(encode()) for any chunking and line length', { timeout }, async () => {
        await fc.assert(
            fc.asyncProperty(bytes, chunkSizes, fc.option(lineLength, { nil: undefined }), async (data, sizes, length) => {
                const output = (await runStream(new Encoder({ lineLength: length }), Buffer.from(data), sizes)).toString();
                const expected = refWrap(refEncode(data), length || 76);
                assert.strictEqual(output, expected);
                assert.strictEqual(output, wrap(encode(data), length));
            }),
            params
        );
    });

    it('the Encoder stream without wrapping matches encode', { timeout }, async () => {
        await fc.assert(
            fc.asyncProperty(bytes, chunkSizes, async (data, sizes) => {
                const output = await runStream(new Encoder({ lineLength: false }), Buffer.from(data), sizes);
                assert.strictEqual(output.toString(), refEncode(data));
            }),
            params
        );
    });

    it('the Encoder applies start padding, skipped bytes and the output limit to the wrapped output', { timeout }, async () => {
        await fc.assert(
            fc.asyncProperty(
                bytes,
                chunkSizes,
                lineLength,
                fc.string({ unit: fc.constantFrom('#', ' '), maxLength: 200, size: 'medium' }),
                fc.nat({ max: 3000 }),
                fc.nat({ max: 3000 }),
                async (data, sizes, length, startPadding, skipStartBytes, limitOutputBytes) => {
                    const encoder = new Encoder({ lineLength: length, startPadding, skipStartBytes, limitOutputBytes });
                    const output = (await runStream(encoder, Buffer.from(data), sizes)).toString();
                    const full = refWrap(startPadding + refEncode(data), length);
                    assert.strictEqual(output, full.slice(skipStartBytes, limitOutputBytes ? skipStartBytes + limitOutputBytes : undefined));
                    assert.strictEqual(encoder.outputBytes, output.length);
                    assert.strictEqual(encoder.inputBytes, data.length);
                }
            ),
            params
        );
    });

    it('wrap splits plain base64 into lines of the line length', () => {
        fc.assert(
            fc.property(bytes, lineLength, (data, length) => {
                const encoded = refEncode(data);
                const wrapped = wrap(encoded, length);
                assert.strictEqual(wrapped, refWrap(encoded, length));
                assert.strictEqual(wrapped.replace(/\r\n/g, ''), encoded);
                assert.ok(!wrapped.endsWith('\r\n'));
            }),
            params
        );
    });

    it('wrap keeps the line based behaviour for anything else', () => {
        // the regular expression form the line based wrapping has always used. Input longer than 1024
        // lines is processed in pieces of 1024 lines, each trimmed on its own, so only shorter input is
        // compared to it
        const reference = (str: string, length: number) => str.replace(new RegExp('.{' + length + '}', 'g'), '$&\r\n').trim();
        fc.assert(
            fc.property(encodedLike(false), fc.integer({ min: 1, max: 40 }), (str, length) => {
                fc.pre(str.length <= length * 1024);
                assert.strictEqual(wrap(str, length), str.length <= length ? str : reference(str, length));
            }),
            params
        );
    });

    it('the Decoder delivers everything to a slow consumer', { timeout }, async () => {
        await fc.assert(
            fc.asyncProperty(bytes, chunkSizes, fc.integer({ min: 1, max: 64 }), async (data, sizes, highWaterMark) => {
                const input = Buffer.from(wrap(encode(data), 76));
                const received: Buffer[] = [];
                const sink = new Writable({
                    highWaterMark,
                    write(chunk: Buffer, _encoding, done) {
                        received.push(chunk);
                        setImmediate(done);
                    }
                });
                const source = async function* () {
                    for (let pos = 0, i = 0; pos < input.length; i++) {
                        const size = sizes[i % sizes.length];
                        yield input.subarray(pos, pos + size);
                        pos += size;
                    }
                };
                await pipeline(source, new Decoder(), sink);
                assert.ok(Buffer.concat(received).equals(Buffer.from(data)));
            }),
            { ...params, numRuns: Math.max(10, Math.floor(numRuns / 4)) }
        );
    });
});
