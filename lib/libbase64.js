'use strict';

const { Buffer } = require('node:buffer');
const stream = require('node:stream');
const Transform = stream.Transform;

/**
 * Encodes a Buffer into a base64 encoded string
 *
 * @param {Buffer} buffer Buffer to convert
 * @returns {String} base64 encoded string
 */
function encode(buffer) {
    if (typeof buffer === 'string') {
        buffer = Buffer.from(buffer, 'utf-8');
    }

    return buffer.toString('base64');
}

/**
 * Decodes a base64 encoded string to a Buffer object
 *
 * @param {String} str base64 encoded string
 * @returns {Buffer} Decoded value
 */
function decode(str) {
    str = str || '';

    // Buffer.from() stops decoding at the first padding char, so input made of several
    // padded segments (eg. every line padded on its own) is decoded segment by segment
    if (typeof str === 'string') {
        let padPos = str.indexOf('=');
        if (padPos >= 0 && /[a-zA-Z0-9+/\-_]/.test(str.substr(padPos))) {
            let parts = [];
            for (let segment of str.split(/[=]+/)) {
                if (segment) {
                    parts.push(Buffer.from(segment, 'base64'));
                }
            }
            return Buffer.concat(parts);
        }
    }

    return Buffer.from(str, 'base64');
}

/**
 * Turns a line length option into a whole number of characters, the default for anything unusable
 */
function normalizeLineLength(lineLength) {
    lineLength = Math.floor(Number(lineLength));
    return Number.isFinite(lineLength) && lineLength >= 1 ? lineLength : 76;
}

/**
 * Splits the bytes of `src` into lines of `lineLength` bytes, each followed by a line break. With
 * `final` set the last line, which may be shorter, gets no line break; otherwise only complete lines
 * are taken and the rest is left for the caller
 *
 * @param {Buffer} src Bytes to wrap
 * @param {Number} lineLength Line length
 * @param {Boolean} final Whether `src` ends the output
 * @returns {Object} `{ output, rest }`: the wrapped bytes and the number of trailing bytes not taken
 */
function wrapBuffer(src, lineLength, final) {
    let lines = Math.ceil(src.length / lineLength);
    // the last line waits for more data unless this is the end: whether it gets a line break depends on
    // whether anything follows it
    let complete = Math.max(lines - 1, 0);
    let rest = src.length - complete * lineLength;

    let output = Buffer.allocUnsafe(complete * (lineLength + 2) + (final ? rest : 0));
    let to = 0;
    for (let from = 0; from < complete * lineLength; from += lineLength) {
        src.copy(output, to, from, from + lineLength);
        to += lineLength;
        output[to++] = 0x0d;
        output[to++] = 0x0a;
    }
    if (final) {
        to += src.copy(output, to, complete * lineLength);
        rest = 0;
    }

    if (to !== output.length) {
        // never hand out bytes of the unfilled allocation
        throw new Error('Unexpected wrapped length');
    }

    return { output, rest };
}

/**
 * Adds soft line breaks to a base64 string
 *
 * @param {String} str base64 encoded string that might need line wrapping
 * @param {Number} [lineLength=76] Maximum allowed length for a line
 * @returns {String} Soft-wrapped base64 encoded string
 */
function wrap(str, lineLength) {
    str = (str || '').toString();
    lineLength = normalizeLineLength(lineLength);

    if (str.length <= lineLength) {
        return str;
    }

    // eslint-disable-next-line no-control-regex
    if (/[^\u0000-\u00ff]|[\r\n]/.test(str) || str.trim() !== str) {
        // not a plain base64 string, keep the line based behaviour for whatever this is
        return legacyWrap(str, lineLength);
    }

    return wrapBuffer(Buffer.from(str, 'latin1'), lineLength, true).output.toString('latin1');
}

/**
 * Line wrapping for input that is not a plain base64 string: line breaks already in the input end a
 * line, and surrounding whitespace is trimmed
 */
function legacyWrap(str, lineLength) {
    let result = [];
    let pos = 0;
    let chunkLength = lineLength * 1024;
    while (pos < str.length) {
        let wrappedLines = str
            .substr(pos, chunkLength)
            .replace(new RegExp('.{' + lineLength + '}', 'g'), '$&\r\n')
            .trim();
        result.push(wrappedLines);
        pos += chunkLength;
    }

    return result.join('\r\n').trim();
}

/**
 * Creates a transform stream for encoding data to base64 encoding
 *
 * The output is the same as `wrap(encode(input), lineLength)` no matter how the input is split into
 * chunks: every line but the last one ends with a line break, the last one does not
 *
 * @constructor
 * @param {Object} options Stream options
 * @param {Number} [options.lineLength=76] Maximum lenght for lines, set to false to disable wrapping
 * @param {Number} [options.skipStartBytes] Number of output bytes to drop from the start
 * @param {Number} [options.limitOutputBytes] Maximum number of output bytes to emit
 * @param {String} [options.startPadding] Characters to prepend to the first line before wrapping
 */
class Encoder extends Transform {
    constructor(options) {
        super();
        // init Transform
        this.options = options || {};

        if (this.options.lineLength !== false) {
            this.options.lineLength = normalizeLineLength(this.options.lineLength);
        }

        this.skipStartBytes = Number(this.options.skipStartBytes) || 0;
        // `limitOutbutBytes` is the name earlier versions read
        this.limitOutputBytes = Number(this.options.limitOutputBytes || this.options.limitOutbutBytes) || 0;

        // encoded characters of the line that is not complete yet. startPadding can be used together
        // with skipStartBytes
        this._curLine = this.options.startPadding || '';
        // input bytes that do not make up a complete base64 group yet
        this._remainingBytes = null;

        this.inputBytes = 0;
        this.outputBytes = 0;
    }

    _writeChunk(chunk) {
        if (this.skipStartBytes) {
            if (chunk.length <= this.skipStartBytes) {
                this.skipStartBytes -= chunk.length;
                return;
            }

            chunk = chunk.subarray(this.skipStartBytes);
            this.skipStartBytes = 0;
        }

        if (this.limitOutputBytes) {
            if (this.outputBytes >= this.limitOutputBytes) {
                // chunks already processed
                return;
            }
            if (this.outputBytes + chunk.length > this.limitOutputBytes) {
                // use partial chunk
                chunk = chunk.subarray(0, this.limitOutputBytes - this.outputBytes);
            }
        }

        this.outputBytes += chunk.length;
        this.push(chunk);
    }

    /**
     * Emits the encoded characters `b64` that follow the current line, keeping what can not be emitted
     * yet as the new current line
     */
    _emit(b64, final) {
        let src = Buffer.from(this._curLine + b64, 'latin1');
        if (!src.length) {
            return;
        }

        if (!this.options.lineLength) {
            this._curLine = '';
            return this._writeChunk(src);
        }

        let { output, rest } = wrapBuffer(src, this.options.lineLength, final);
        this._curLine = rest ? src.toString('latin1', src.length - rest) : '';
        if (output.length) {
            this._writeChunk(output);
        }
    }

    _transform(chunk, encoding, done) {
        if (encoding !== 'buffer') {
            chunk = Buffer.from(chunk, encoding);
        }

        if (!chunk || !chunk.length) {
            return done();
        }

        this.inputBytes += chunk.length;

        if (this._remainingBytes) {
            chunk = Buffer.concat([this._remainingBytes, chunk], this._remainingBytes.length + chunk.length);
            this._remainingBytes = null;
        }

        let extra = chunk.length % 3;
        if (extra) {
            this._remainingBytes = chunk.subarray(chunk.length - extra);
            chunk = chunk.subarray(0, chunk.length - extra);
        }

        this._emit(encode(chunk), false);
        done();
    }

    _flush(done) {
        this._emit(this._remainingBytes ? encode(this._remainingBytes) : '', true);
        done();
    }
}

/**
 * Creates a transform stream for decoding base64 encoded strings
 *
 * @constructor
 * @param {Object} options Stream options
 */
class Decoder extends Transform {
    constructor(options) {
        super();
        // init Transform
        this.options = options || {};
        this._curLine = '';

        this.inputBytes = 0;
        this.outputBytes = 0;
    }

    _transform(chunk, encoding, done) {
        if (!chunk || !chunk.length) {
            return setImmediate(done);
        }

        this.inputBytes += chunk.length;

        let b64 = this._curLine + chunk.toString('ascii');
        this._curLine = '';

        if (/[^a-zA-Z0-9+/=]/.test(b64)) {
            b64 = b64.replace(/[^a-zA-Z0-9+/=]/g, '');
        }

        // everything up to the last padding char ends in complete segments, quartets are
        // only counted from there on as a padding run restarts the quartet alignment
        let padded = '';
        let lastPad = b64.lastIndexOf('=');
        if (lastPad >= 0) {
            padded = b64.substr(0, lastPad + 1);
            b64 = b64.substr(lastPad + 1);
        }

        if (b64.length < 4) {
            this._curLine = b64;
            b64 = '';
        } else if (b64.length % 4) {
            this._curLine = b64.substr(-b64.length % 4);
            b64 = b64.substr(0, b64.length - this._curLine.length);
        }

        b64 = padded + b64;

        if (b64) {
            let buf = decode(b64);
            this.outputBytes += buf.length;
            this.push(buf);
        }

        setImmediate(done);
    }

    _flush(done) {
        if (this._curLine) {
            let buf = decode(this._curLine);
            this.outputBytes += buf.length;
            this.push(buf);
            this._curLine = '';
        }
        setImmediate(done);
    }
}

// expose to the world
module.exports = {
    encode,
    decode,
    wrap,
    Encoder,
    Decoder
};
