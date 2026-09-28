/* eslint no-unused-expressions:0, prefer-arrow-callback: 0 */

'use strict';

const { Buffer } = require('node:buffer');
let libbase64 = require('../lib/libbase64');
let chai = require('chai');
let expect = chai.expect;
let crypto = require('node:crypto');
let fs = require('node:fs');

chai.config.includeStack = true;

describe('libbase64', () => {
    let encodeFixtures = [
        ['abcd= ÕÄÖÜ', 'YWJjZD0gw5XDhMOWw5w='],
        ['foo bar  ', 'Zm9vIGJhciAg'],
        ['foo bar\t\t', 'Zm9vIGJhcgkJ'],
        ['foo \r\nbar', 'Zm9vIA0KYmFy']
    ];

    let decodeFixtures = [['foo bar\r\nbaz\r\n', 'Zm9v\r\nIGJhcg0\r\nKYmF6DQo=']];

    let wrapFixtures = [['dGVyZSwgdGVyZSwgdmFuYSBrZXJlLCBrdWlkYXMgc3VsIGzDpGhlYj8=', 'dGVyZSwgdGVyZSwgdmFu\r\nYSBrZXJlLCBrdWlkYXMg\r\nc3VsIGzDpGhlYj8=']];

    let streamFixture = [
        '123456789012345678  90\r\nõäöüõäöüõäöüõäöüõäöüõäöüõäöüõäöü another line === ',
        'MTIzNDU2N\r\nzg5MDEyMz\r\nQ1Njc4ICA\r\n5MA0Kw7XD\r\npMO2w7zDt\r\ncOkw7bDvM\r\nO1w6TDtsO\r\n8w7XDpMO2\r\nw7zDtcOkw\r\n7bDvMO1w6\r\nTDtsO8w7X\r\nDpMO2w7zD\r\ntcOkw7bDv\r\nCBhbm90aG\r\nVyIGxpbmU\r\ngPT09IA=='
    ];

    describe('#encode', () => {
        it('shoud encode UTF-8 string to base64', () => {
            encodeFixtures.forEach(test => {
                expect(libbase64.encode(test[0])).to.equal(test[1]);
            });
        });

        it('shoud encode Buffer to base64', () => {
            expect(libbase64.encode(Buffer.from([0x00, 0x01, 0x02, 0x20, 0x03]))).to.equal('AAECIAM=');
        });
    });

    describe('#decode', () => {
        it('shoud decode base64', () => {
            encodeFixtures.concat(decodeFixtures).forEach(test => {
                expect(libbase64.decode(test[1]).toString('utf-8')).to.equal(test[0]);
            });
        });
    });

    describe('#wrap', () => {
        it('should wrap long base64 encoded lines', () => {
            wrapFixtures.forEach(test => {
                expect(libbase64.wrap(test[0], 20)).to.equal(test[1]);
            });
        });
    });

    describe('base64 Streams', () => {
        it('should transform incoming bytes to base64', done => {
            let encoder = new libbase64.Encoder({
                lineLength: 9
            });

            let bytes = Buffer.from(streamFixture[0]),
                i = 0,
                buf = [],
                buflen = 0;

            encoder.on('data', chunk => {
                buf.push(chunk);
                buflen += chunk.length;
            });

            encoder.on('end', chunk => {
                if (chunk) {
                    buf.push(chunk);
                    buflen += chunk.length;
                }
                buf = Buffer.concat(buf, buflen);

                expect(buf.toString()).to.equal(streamFixture[1]);
                done();
            });

            let sendNextByte = function () {
                if (i >= bytes.length) {
                    return encoder.end();
                }

                let ord = bytes[i++];
                encoder.write(Buffer.from([ord]));
                setImmediate(sendNextByte);
            };

            sendNextByte();
        });

        it('should transform incoming bytes to limited base64', done => {
            let start = 20;
            let total = 77;
            let encoder = new libbase64.Encoder({
                lineLength: 9,
                skipStartBytes: start,
                limitOutbutBytes: total
            });

            let bytes = Buffer.from(streamFixture[0]),
                i = 0,
                buf = [],
                buflen = 0;

            encoder.on('data', chunk => {
                buf.push(chunk);
                buflen += chunk.length;
            });

            encoder.on('end', chunk => {
                if (chunk) {
                    buf.push(chunk);
                    buflen += chunk.length;
                }
                buf = Buffer.concat(buf, buflen);
                expect(buf.toString()).to.equal(streamFixture[1].substr(start, total));
                done();
            });

            let sendNextByte = function () {
                if (i >= bytes.length) {
                    return encoder.end();
                }

                let ord = bytes[i++];
                encoder.write(Buffer.from([ord]));
                setImmediate(sendNextByte);
            };

            sendNextByte();
        });

        it('should transform incoming base64 to bytes', done => {
            let decoder = new libbase64.Decoder();

            let bytes = Buffer.from(streamFixture[1]),
                i = 0,
                buf = [],
                buflen = 0;

            decoder.on('data', chunk => {
                buf.push(chunk);
                buflen += chunk.length;
            });

            decoder.on('end', chunk => {
                if (chunk) {
                    buf.push(chunk);
                    buflen += chunk.length;
                }
                buf = Buffer.concat(buf, buflen);

                expect(buf.toString()).to.equal(streamFixture[0]);
                done();
            });

            let sendNextByte = function () {
                if (i >= bytes.length) {
                    return decoder.end();
                }

                let ord = bytes[i++];
                decoder.write(Buffer.from([ord]));
                setImmediate(sendNextByte);
            };

            sendNextByte();
        });

        it('should transform incoming bytes to base64 and back', done => {
            let decoder = new libbase64.Decoder();
            let encoder = new libbase64.Encoder();
            let file = fs.createReadStream(__dirname + '/fixtures/alice.txt');

            let fhash = crypto.createHash('md5');
            let dhash = crypto.createHash('md5');

            file.pipe(encoder).pipe(decoder);

            file.on('data', chunk => {
                fhash.update(chunk);
            });

            file.on('end', () => {
                fhash = fhash.digest('hex');
            });

            decoder.on('data', chunk => {
                dhash.update(chunk);
            });

            decoder.on('end', () => {
                dhash = dhash.digest('hex');
                expect(fhash).to.equal(dhash);
                done();
            });
        });
    });

    describe('Padding inside the input', () => {
        // writes the input in pieces of chunkSize bytes and resolves with the transformed output
        let runStream = (stream, input, chunkSize) =>
            new Promise((resolve, reject) => {
                let output = [];
                stream.on('data', chunk => output.push(chunk));
                stream.on('end', () => resolve(Buffer.concat(output)));
                stream.on('error', reject);
                for (let pos = 0; pos < input.length; pos += chunkSize) {
                    stream.write(input.subarray(pos, pos + chunkSize));
                }
                stream.end();
            });

        let paddedLines = 'YQ==\r\nYg==\r\nYw==';

        it('should decode padded lines concatenated', () => {
            expect(libbase64.decode(paddedLines).toString()).to.equal('abc');
            expect(libbase64.decode('YQ==Yg==Yw==').toString()).to.equal('abc');
            expect(libbase64.decode('YWI=YWJj').toString()).to.equal('ababc');
        });

        it('should decode padded segments separated by whitespace', () => {
            expect(libbase64.decode('YQ== \r\n\t Yg=\r\n= Yw').toString()).to.equal('abc');
        });

        it('should not change decoding of Buffer input', () => {
            expect(libbase64.decode(Buffer.from('YQ==Yg==')).toString()).to.equal('YQ==Yg==');
        });

        it('should stream decode padded lines with any chunk size', async () => {
            let input = Buffer.from(paddedLines);
            for (let chunkSize = 1; chunkSize <= input.length; chunkSize++) {
                let output = await runStream(new libbase64.Decoder(), input, chunkSize);
                expect(output.toString(), 'chunk size ' + chunkSize).to.equal('abc');
            }
        });

        it('should stream decode padding split across chunks', async () => {
            let decoder = new libbase64.Decoder();
            let result = new Promise((resolve, reject) => {
                let output = [];
                decoder.on('data', chunk => output.push(chunk));
                decoder.on('end', () => resolve(Buffer.concat(output)));
                decoder.on('error', reject);
            });
            // the "==" run of the first segment arrives as "=" + "="
            decoder.write(Buffer.from('YWJjZA='));
            decoder.write(Buffer.from('=\r\nZW'));
            decoder.write(Buffer.from('Y'));
            decoder.end(Buffer.from('='));
            expect((await result).toString()).to.equal('abcdef');
        });

        it('should round trip random data through Encoder and Decoder', async () => {
            let data = crypto.randomBytes(100 * 1024);
            for (let chunkSize of [3, 4, 5, 7, 76, 78, 1000, 4096, 65536]) {
                let encoded = await runStream(new libbase64.Encoder(), data, chunkSize);
                let decoded = await runStream(new libbase64.Decoder(), encoded, chunkSize);
                expect(decoded.equals(data), 'chunk size ' + chunkSize).to.be.true;
            }
        }).timeout(60 * 1000); // every chunk costs a setImmediate() in both streams

        it('should round trip separately encoded parts', async () => {
            // each part is padded on its own, as when encoded pieces are glued together
            let parts = [crypto.randomBytes(1), crypto.randomBytes(2), crypto.randomBytes(3), crypto.randomBytes(100)];
            let input = Buffer.from(parts.map(part => libbase64.encode(part)).join('\r\n'));
            let expected = Buffer.concat(parts);
            expect(libbase64.decode(input.toString()).equals(expected)).to.be.true;
            for (let chunkSize of [1, 2, 3, 5, 16, input.length]) {
                let decoded = await runStream(new libbase64.Decoder(), input, chunkSize);
                expect(decoded.equals(expected), 'chunk size ' + chunkSize).to.be.true;
            }
        });
    });
});
