import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import path from 'node:path';
import type { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import libbase64, { encode, decode, wrap, Encoder, Decoder, type EncoderOptions } from '../src/libbase64.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// resolves with everything the stream emits, once it ends
const collect = (stream: Transform): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const output: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => output.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(output)));
        stream.on('error', reject);
    });

// writes the input in pieces (a chunk size, or a list of sizes used in turn, 0 writes an empty
// chunk) and resolves with the transformed output
const runStream = (stream: Transform, input: Buffer, chunkSizes: number | number[]): Promise<Buffer> => {
    const result = collect(stream);
    const sizes = ([] as number[]).concat(chunkSizes);
    for (let pos = 0, i = 0; pos < input.length; i++) {
        const size = sizes[i % sizes.length];
        stream.write(input.subarray(pos, pos + size));
        pos += size;
    }
    stream.end();
    return result;
};

// writes the input one byte per event loop turn
const runStreamSlowly = (stream: Transform, input: Buffer): Promise<Buffer> => {
    const result = collect(stream);
    let i = 0;
    const sendNextByte = () => {
        if (i >= input.length) {
            stream.end();
            return;
        }
        stream.write(input.subarray(i, ++i));
        setImmediate(sendNextByte);
    };
    sendNextByte();
    return result;
};

const encodeFixtures = [
    ['abcd= ÕÄÖÜ', 'YWJjZD0gw5XDhMOWw5w='],
    ['foo bar  ', 'Zm9vIGJhciAg'],
    ['foo bar\t\t', 'Zm9vIGJhcgkJ'],
    ['foo \r\nbar', 'Zm9vIA0KYmFy']
];

const decodeFixtures = [['foo bar\r\nbaz\r\n', 'Zm9v\r\nIGJhcg0\r\nKYmF6DQo=']];

const wrapFixtures = [['dGVyZSwgdGVyZSwgdmFuYSBrZXJlLCBrdWlkYXMgc3VsIGzDpGhlYj8=', 'dGVyZSwgdGVyZSwgdmFu\r\nYSBrZXJlLCBrdWlkYXMg\r\nc3VsIGzDpGhlYj8=']];

const streamFixture = [
    '123456789012345678  90\r\nõäöüõäöüõäöüõäöüõäöüõäöüõäöüõäöü another line === ',
    'MTIzNDU2N\r\nzg5MDEyMz\r\nQ1Njc4ICA\r\n5MA0Kw7XD\r\npMO2w7zDt\r\ncOkw7bDvM\r\nO1w6TDtsO\r\n8w7XDpMO2\r\nw7zDtcOkw\r\n7bDvMO1w6\r\nTDtsO8w7X\r\nDpMO2w7zD\r\ntcOkw7bDv\r\nCBhbm90aG\r\nVyIGxpbmU\r\ngPT09IA=='
];

describe('libbase64', () => {
    describe('#encode', () => {
        it('should encode UTF-8 string to base64', () => {
            for (const [input, expected] of encodeFixtures) {
                assert.strictEqual(encode(input), expected);
            }
        });

        it('should encode Buffer to base64', () => {
            assert.strictEqual(encode(Buffer.from([0x00, 0x01, 0x02, 0x20, 0x03])), 'AAECIAM=');
        });

        it('should encode a plain Uint8Array and a view into a larger buffer', () => {
            assert.strictEqual(encode(new Uint8Array([0x00, 0x01, 0x02, 0x20, 0x03])), 'AAECIAM=');
            const view = new Uint8Array(new Uint8Array([0xff, 0x00, 0x01, 0x02, 0x20, 0x03, 0xff]).buffer, 1, 5);
            assert.strictEqual(encode(view), 'AAECIAM=');
        });
    });

    describe('#decode', () => {
        it('should decode base64', () => {
            for (const [expected, input] of encodeFixtures.concat(decodeFixtures)) {
                assert.strictEqual(decode(input).toString('utf-8'), expected);
            }
        });

        it('should decode empty input to an empty buffer', () => {
            for (const input of ['', null, undefined]) {
                assert.strictEqual(decode(input).length, 0);
            }
        });

        it('should skip characters outside of latin1', () => {
            // Buffer reads only the low byte, "\u0141" (Ł) and "\u2062" would be read as "A" and "b"
            assert.strictEqual(decode('YW\u0141Jj\u2062').toString(), 'abc');
            assert.strictEqual(decode('YWJj\u0141=YWJj').toString(), 'abcabc');
        });
    });

    describe('#wrap', () => {
        it('should wrap long base64 encoded lines', () => {
            for (const [input, expected] of wrapFixtures) {
                assert.strictEqual(wrap(input, 20), expected);
            }
        });

        it('should match line based wrapping for every kind of input', () => {
            // reference implementation of the line based wrapping
            const reference = (str: string, lineLength: number) => str.replace(new RegExp('.{' + lineLength + '}', 'g'), '$&\r\n').trim();
            for (const input of ['ABCabc+/=0'.repeat(50), ' padded '.repeat(30), 'line\r\nbreaks\r\n'.repeat(20), 'x'.repeat(76), 'x'.repeat(77)]) {
                for (const lineLength of [1, 5, 76]) {
                    assert.strictEqual(wrap(input, lineLength), reference(input, lineLength), JSON.stringify([input.slice(0, 20), lineLength]));
                }
            }
        });

        it('should terminate for a negative or zero line length and keep the content', () => {
            const input = encode('tere tere vana kere'.repeat(20));
            for (const lineLength of [-10, -1, 0, 1, 2, 76]) {
                assert.strictEqual(wrap(input, lineLength).replace(/\r\n/g, ''), input, `lineLength ${lineLength}`);
            }
            assert.strictEqual(wrap(input, 0), wrap(input, 76));
        });

        it('should wrap Buffer input and return empty input as an empty string', () => {
            assert.strictEqual(wrap(Buffer.from(wrapFixtures[0][0]), 20), wrapFixtures[0][1]);
            assert.strictEqual(wrap(null), '');
            assert.strictEqual(wrap(undefined, 10), '');
        });
    });

    describe('base64 Streams', () => {
        it('should transform incoming bytes to base64', async () => {
            const output = await runStreamSlowly(new Encoder({ lineLength: 9 }), Buffer.from(streamFixture[0]));
            assert.strictEqual(output.toString(), streamFixture[1]);
        });

        it('should transform incoming bytes to limited base64', async () => {
            const start = 20;
            const total = 77;
            const encoder = new Encoder({ lineLength: 9, skipStartBytes: start, limitOutbutBytes: total });
            const output = await runStreamSlowly(encoder, Buffer.from(streamFixture[0]));
            assert.strictEqual(output.toString(), streamFixture[1].substr(start, total));
        });

        it('should transform incoming base64 to bytes', async () => {
            const output = await runStreamSlowly(new Decoder(), Buffer.from(streamFixture[1]));
            assert.strictEqual(output.toString(), streamFixture[0]);
        });

        it('should transform incoming bytes to base64 and back', async () => {
            const file = path.join(root, 'test', 'fixtures', 'alice.txt');
            const decoder = new Decoder();
            const decoded = collect(decoder);
            await pipeline(fs.createReadStream(file), new Encoder(), decoder);
            assert.ok((await decoded).equals(fs.readFileSync(file)));
        });

        it('should count input and output bytes', async () => {
            const data = crypto.randomBytes(1000);
            const encoder = new Encoder();
            const encoded = await runStream(encoder, data, 100);
            assert.strictEqual(encoder.inputBytes, 1000);
            assert.strictEqual(encoder.outputBytes, encoded.length);
            const decoder = new Decoder();
            await runStream(decoder, encoded, 100);
            assert.strictEqual(decoder.inputBytes, encoded.length);
            assert.strictEqual(decoder.outputBytes, 1000);
        });

        it('should encode string writes with their encoding', async () => {
            const encoder = new Encoder();
            const output = collect(encoder);
            encoder.write('õ', 'latin1');
            encoder.end('õ', 'utf-8');
            assert.strictEqual((await output).toString(), encode(Buffer.from([0xf5, 0xc3, 0xb5])));
        });
    });

    describe('Decoder input', () => {
        it('should skip 8-bit bytes like decode() does', async () => {
            // "é" is 0xc3 0xa9 in UTF-8: with the high bit cleared these would be read as "C" and ")"
            const input = Buffer.concat([Buffer.from('YW'), Buffer.from('é', 'utf-8'), Buffer.from('Jj'), Buffer.from([0xc1, 0xd1, 0xe2])]);
            assert.strictEqual(decode(input.toString('latin1')).toString(), 'abc');
            for (const chunkSize of [1, 2, 3, input.length]) {
                const output = await runStream(new Decoder(), input, chunkSize);
                assert.strictEqual(output.toString(), 'abc', 'chunk size ' + chunkSize);
            }
        });

        it('should skip whitespace and other characters outside of the base64 alphabet', async () => {
            const input = Buffer.from(' YW\tJj\r\n.ZG!Vm\r\n');
            assert.strictEqual((await runStream(new Decoder(), input, 3)).toString(), 'abcdef');
        });

        it('should decode an unpadded tail when the stream ends', async () => {
            // "YWJjZA" and "YWJjZGU" are "abcd" and "abcde" without the padding
            for (const [input, expected] of [
                ['YWJjZA', 'abcd'],
                ['YWJjZGU', 'abcde'],
                ['YQ==YWI', 'aab'],
                ['YW', 'a']
            ]) {
                assert.strictEqual(decode(input).toString(), expected, input);
                for (const chunkSize of [1, 2, 3, input.length]) {
                    const output = await runStream(new Decoder(), Buffer.from(input), chunkSize);
                    assert.strictEqual(output.toString(), expected, input + ' chunk size ' + chunkSize);
                }
            }
        });

        it('should decode input without any base64 characters to nothing', async () => {
            for (const input of ['\r\n', '====', ' \t.!']) {
                assert.strictEqual(decode(input).length, 0, JSON.stringify(input));
                assert.strictEqual((await runStream(new Decoder(), Buffer.from(input), 1)).length, 0, JSON.stringify(input));
            }
        });

        it('should ignore empty writes', async () => {
            assert.strictEqual((await runStream(new Decoder(), Buffer.from('YWJj'), [0, 4])).toString(), 'abc');
        });
    });

    describe('Padding inside the input', () => {
        const paddedLines = 'YQ==\r\nYg==\r\nYw==';

        it('should decode padded lines concatenated', () => {
            assert.strictEqual(decode(paddedLines).toString(), 'abc');
            assert.strictEqual(decode('YQ==Yg==Yw==').toString(), 'abc');
            assert.strictEqual(decode('YWI=YWJj').toString(), 'ababc');
        });

        it('should decode padded segments separated by whitespace', () => {
            assert.strictEqual(decode('YQ== \r\n\t Yg=\r\n= Yw').toString(), 'abc');
        });

        it('should not change decoding of Buffer input', () => {
            assert.strictEqual(decode(Buffer.from('YQ==Yg==')).toString(), 'YQ==Yg==');
        });

        it('should stream decode padded lines with any chunk size', async () => {
            const input = Buffer.from(paddedLines);
            for (let chunkSize = 1; chunkSize <= input.length; chunkSize++) {
                const output = await runStream(new Decoder(), input, chunkSize);
                assert.strictEqual(output.toString(), 'abc', 'chunk size ' + chunkSize);
            }
        });

        it('should stream decode padding split across chunks', async () => {
            // the "==" run of the first segment arrives as "=" + "=": chunks "YWJjZA=", "=\r\nZW", "Y", "="
            const output = await runStream(new Decoder(), Buffer.from('YWJjZA==\r\nZWY='), [7, 5, 1, 1]);
            assert.strictEqual(output.toString(), 'abcdef');
        });

        it('should round trip random data through Encoder and Decoder', { timeout: 60 * 1000 }, async () => {
            const data = crypto.randomBytes(100 * 1024);
            for (const chunkSize of [3, 4, 5, 7, 76, 78, 1000, 4096, 65536]) {
                const encoded = await runStream(new Encoder(), data, chunkSize);
                const decoded = await runStream(new Decoder(), encoded, chunkSize);
                assert.ok(decoded.equals(data), 'chunk size ' + chunkSize);
            }
        });

        it('should decode every input like segment by segment decoding', () => {
            const alphabet = 'AAAAQQQQYWJjZ+/-_====  \r\n\t.!é';
            for (let i = 0; i < 20000; i++) {
                const input = Array.from(crypto.randomBytes(i % 40), byte => alphabet[byte % alphabet.length]).join('');
                const expected = Buffer.concat(
                    input
                        .split(/[=]+/)
                        .filter(segment => segment)
                        .map(segment => Buffer.from(segment, 'base64'))
                );
                assert.ok(decode(input).equals(expected), JSON.stringify(input));
            }
        });

        it(
            'should decode many padded segments in memory proportional to the input',
            { timeout: 60 * 1000, skip: process.versions.bun ? 'needs a Node.js heap limit' : false },
            () => {
                // 4,000,000 padded lines (24 MB) used to keep a Buffer per line and needed several
                // hundred MB of heap
                const script = [
                    "import { decode } from './src/libbase64.ts';",
                    "let decoded = decode('AA==\\r\\n'.repeat(4000000));",
                    "let units = decode('AB='.repeat(2000000));",
                    'if (decoded.length !== 4000000 || units.length !== 2000000) process.exit(2);'
                ].join('\n');
                const result = childProcess.spawnSync(process.execPath, ['--max-old-space-size=128', '--import', 'tsx', '--input-type=module', '-e', script], {
                    cwd: root,
                    encoding: 'utf-8'
                });
                assert.strictEqual(result.status, 0, result.stderr.slice(0, 500));
            }
        );

        it('should round trip separately encoded parts', async () => {
            // each part is padded on its own, as when encoded pieces are glued together
            const parts = [crypto.randomBytes(1), crypto.randomBytes(2), crypto.randomBytes(3), crypto.randomBytes(100)];
            const input = Buffer.from(parts.map(part => encode(part)).join('\r\n'));
            const expected = Buffer.concat(parts);
            assert.ok(decode(input.toString()).equals(expected));
            for (const chunkSize of [1, 2, 3, 5, 16, input.length]) {
                const decoded = await runStream(new Decoder(), input, chunkSize);
                assert.ok(decoded.equals(expected), 'chunk size ' + chunkSize);
            }
        });
    });

    describe('Encoder output', () => {
        const runEncoder = async (options: EncoderOptions, input: Buffer, chunkSizes: number | number[]) =>
            (await runStream(new Encoder(options), input, chunkSizes)).toString();

        it('should not depend on how the input is chunked', async () => {
            // 1140 bytes encode to exactly 20 lines of 76 characters, the layout where a chunk can end on a line end
            for (const length of [0, 1, 2, 3, 57, 114, 1140, 1141, 5000]) {
                const data = crypto.randomBytes(length);
                const expected = wrap(encode(data), 76);
                for (const chunkSizes of [[1], [3], [57], [1139, 1], [100, 14], [length || 1]]) {
                    assert.strictEqual(await runEncoder({}, data, chunkSizes), expected, `length ${length} chunks ${chunkSizes}`);
                }
            }
        });

        it('should never end with a line break', async () => {
            for (const lineLength of [1, 3, 4, 76]) {
                const data = crypto.randomBytes(lineLength * 3);
                const output = await runEncoder({ lineLength }, data, [1]);
                assert.ok(!output.endsWith('\r\n'), `line length ${lineLength}`);
                assert.strictEqual(output, wrap(encode(data), lineLength));
            }
        });

        it('should apply padding, skipped bytes and the output limit to the wrapped output', async () => {
            const data = crypto.randomBytes(1000);
            const full = wrap('#'.repeat(10) + encode(data), 76);
            for (const limit of [1, 77, 78, 500]) {
                const options = { startPadding: '#'.repeat(10), skipStartBytes: 12, limitOutputBytes: limit };
                assert.strictEqual(await runEncoder(options, data, [7, 57]), full.substr(12, limit));
            }
            // the misspelled option name earlier versions read is still accepted
            assert.strictEqual(await runEncoder({ limitOutbutBytes: 20 }, data, [100]), wrap(encode(data), 76).substr(0, 20));
        });

        it('should skip output across several chunks', async () => {
            const data = crypto.randomBytes(1000);
            assert.strictEqual(await runEncoder({ skipStartBytes: 500 }, data, [3]), wrap(encode(data), 76).substr(500));
        });

        it('should only use whole line lengths', async () => {
            const data = crypto.randomBytes(300);
            const encoded = encode(data);
            const cases: [number | string, number][] = [
                [2.5, 2],
                [76.9, 76],
                ['76', 76],
                [' 7', 7],
                [0.5, 76],
                ['abc', 76],
                [Infinity, 76],
                [-3, 76]
            ];
            for (const [lineLength, used] of cases) {
                const expected = wrap(encoded, used);
                assert.strictEqual(wrap(encoded, lineLength), expected, String(lineLength));
                assert.strictEqual(await runEncoder({ lineLength }, data, [7]), expected, String(lineLength));
            }
        });

        it('should ignore empty writes', async () => {
            assert.strictEqual(await runEncoder({ lineLength: 4 }, Buffer.from('abcdef'), [2, 0, 4]), 'YWJj\r\nZGVm');
        });

        it('should emit nothing for an output limit reached in an earlier chunk', async () => {
            const data = crypto.randomBytes(1000);
            const encoder = new Encoder({ limitOutputBytes: 10 });
            assert.strictEqual((await runStream(encoder, data, [6, 6, 300])).toString(), encode(data).slice(0, 10));
            assert.strictEqual(encoder.outputBytes, 10);
        });

        it('should not change the output for an empty start padding or zero skipped bytes', async () => {
            const data = crypto.randomBytes(200);
            assert.strictEqual(await runEncoder({ startPadding: '', skipStartBytes: 0, limitOutputBytes: 0 }, data, [7]), wrap(encode(data)));
        });

        it('should not wrap when line length is false', async () => {
            const data = crypto.randomBytes(500);
            assert.strictEqual(await runEncoder({ lineLength: false }, data, [7, 3]), encode(data));
        });
    });

    describe('Default export', () => {
        it('should expose the same members as the named exports', () => {
            assert.deepStrictEqual(libbase64, { encode, decode, wrap, Encoder, Decoder });
        });
    });
});
