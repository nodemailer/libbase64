'use strict';

// Loads the CommonJS build the way EmailEngine's @yao-pkg/pkg binary does. Run with
// --no-experimental-require-module (`npm run test:cjs`) so an ES module anywhere in the
// require() graph fails here instead of being loaded through require(esm).

const assert = require('node:assert/strict');
const pkg = require('../package.json');

const libbase64 = require('../' + pkg.exports['.'].require);

assert.strictEqual(libbase64.default, libbase64);
assert.strictEqual(libbase64.encode('tere jõgeva'), 'dGVyZSBqw7VnZXZh');
assert.strictEqual(libbase64.decode('dGVyZSBqw7VnZXZh').toString(), 'tere jõgeva');
assert.strictEqual(libbase64.wrap('abcdefghij', 4), 'abcd\r\nefgh\r\nij');

let streamed = false;
process.on('exit', () => assert.ok(streamed, 'the stream round trip did not finish'));

const encoder = new libbase64.Encoder({ lineLength: 4 });
const chunks = [];
encoder.on('data', chunk => chunks.push(chunk));
encoder.on('end', () => {
    const encoded = Buffer.concat(chunks).toString();
    assert.strictEqual(encoded, 'dGVy\r\nZSBq\r\nw7Vn\r\nZXZh');

    const decoder = new libbase64.Decoder();
    const decoded = [];
    decoder.on('data', chunk => decoded.push(chunk));
    decoder.on('end', () => {
        assert.strictEqual(Buffer.concat(decoded).toString(), 'tere jõgeva');
        streamed = true;
        console.log('CommonJS build loads and works without require(esm)');
    });
    decoder.end(encoded);
});
encoder.end(Buffer.from('tere jõgeva'));
