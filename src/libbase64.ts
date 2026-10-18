import { Buffer } from 'node:buffer';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Encodes a Buffer into a base64 encoded string
 *
 * @param buffer Buffer or unicode string to convert
 * @returns base64 encoded string
 */
export function encode(buffer: Buffer | Uint8Array | string): string {
    if (typeof buffer === 'string') {
        return Buffer.from(buffer, 'utf-8').toString('base64');
    }
    if (!Buffer.isBuffer(buffer)) {
        // a plain Uint8Array has no base64 toString(), it would turn into a list of numbers
        return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('base64');
    }

    return buffer.toString('base64');
}

/**
 * Decodes a base64 encoded string to a Buffer object
 *
 * @param str base64 encoded string
 * @returns Decoded value
 */
export function decode(str: string | Buffer | null | undefined): Buffer {
    str = str || '';

    // Buffer.from() stops decoding at the first padding char, so input made of several
    // padded segments (eg. every line padded on its own) is decoded segment by segment.
    // Segments are found with indexOf and written into one buffer: splitting the input and
    // keeping a Buffer per segment cost memory per segment, tens of times the input size
    // for a body that pads every line.
    if (typeof str === 'string') {
        let padPos = str.indexOf('=');
        if (padPos >= 0 && /[a-zA-Z0-9+/\-_]/.test(str.slice(padPos))) {
            // a segment of n characters decodes to at most n * 3 / 4 bytes
            let output = Buffer.alloc(Math.floor((str.length * 3) / 4));
            let length = 0;
            let start = 0;
            while (start <= str.length) {
                let end = str.indexOf('=', start);
                if (end < 0) {
                    end = str.length;
                }
                if (end > start) {
                    length += output.write(str.substring(start, end), length, 'base64');
                }
                start = end + 1;
            }
            // copied out so the result does not keep the oversized buffer alive
            return Buffer.from(output.subarray(0, length));
        }
    }

    // a Buffer is copied as it is, the encoding argument only applies to strings
    return Buffer.from(str as string, 'base64');
}

/**
 * Turns a line length option into a whole number of characters, the default for anything unusable
 */
function normalizeLineLength(lineLength: unknown): number {
    let length = Math.floor(Number(lineLength));
    return Number.isFinite(length) && length >= 1 ? length : 76;
}

/**
 * Splits the bytes of `src` into lines of `lineLength` bytes, each followed by a line break. With
 * `final` set the last line, which may be shorter, gets no line break; otherwise only complete lines
 * are taken and the rest is left for the caller
 *
 * @param src Bytes to wrap
 * @param lineLength Line length
 * @param final Whether `src` ends the output
 * @returns The wrapped bytes and the number of trailing bytes not taken
 */
function wrapBuffer(src: Buffer, lineLength: number, final: boolean): { output: Buffer; rest: number } {
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
 * @param str base64 encoded string that might need line wrapping
 * @param [lineLength=76] Maximum allowed length for a line
 * @returns Soft-wrapped base64 encoded string
 */
export function wrap(str: string | Buffer | null | undefined, lineLength?: number | string | null): string {
    str = (str || '').toString();
    let length = normalizeLineLength(lineLength);

    if (str.length <= length) {
        return str;
    }

    if (/[^\u0000-\u00ff]|[\r\n]/.test(str) || str.trim() !== str) {
        // not a plain base64 string, keep the line based behaviour for whatever this is
        return legacyWrap(str, length);
    }

    return wrapBuffer(Buffer.from(str, 'latin1'), length, true).output.toString('latin1');
}

/**
 * Line wrapping for input that is not a plain base64 string: line breaks already in the input end a
 * line, and surrounding whitespace is trimmed
 */
function legacyWrap(str: string, lineLength: number): string {
    let result: string[] = [];
    let pos = 0;
    let chunkLength = lineLength * 1024;
    let wrapRegex = new RegExp('.{' + lineLength + '}', 'g');
    while (pos < str.length) {
        let wrappedLines = str
            .slice(pos, pos + chunkLength)
            .replace(wrapRegex, '$&\r\n')
            .trim();
        result.push(wrappedLines);
        pos += chunkLength;
    }

    return result.join('\r\n').trim();
}

/**
 * Options for the base64 encoder stream
 */
export interface EncoderOptions {
    /** Maximum length for lines, 76 by default. Set to false to disable wrapping */
    lineLength?: number | string | false | undefined;
    /** Number of output bytes to drop from the start */
    skipStartBytes?: number | undefined;
    /** Maximum number of output bytes to emit */
    limitOutputBytes?: number | undefined;
    /**
     * Misspelled name of `limitOutputBytes` that earlier versions read, still accepted
     *
     * @deprecated Use `limitOutputBytes`
     */
    limitOutbutBytes?: number | undefined;
    /** Characters to prepend to the first line before wrapping, usually used together with `skipStartBytes` */
    startPadding?: string | undefined;
}

/**
 * Options for the base64 decoder stream, none are used at the moment
 */
export interface DecoderOptions {
    [key: string]: unknown;
}

/**
 * Creates a transform stream for encoding data to base64 encoding
 *
 * The output is the same as `wrap(encode(input), lineLength)` no matter how the input is split into
 * chunks: every line but the last one ends with a line break, the last one does not
 */
export class Encoder extends Transform {
    options: EncoderOptions;
    skipStartBytes: number;
    limitOutputBytes: number;
    inputBytes: number;
    outputBytes: number;
    /** Encoded characters of the line that is not complete yet @internal */
    _curLine: string;
    /** Input bytes that do not make up a complete base64 group yet @internal */
    _remainingBytes: Buffer | null;

    constructor(options?: EncoderOptions) {
        super();
        this.options = options || {};

        if (this.options.lineLength !== false) {
            this.options.lineLength = normalizeLineLength(this.options.lineLength);
        }

        this.skipStartBytes = Number(this.options.skipStartBytes) || 0;
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        this.limitOutputBytes = Number(this.options.limitOutputBytes || this.options.limitOutbutBytes) || 0;

        // startPadding can be used together with skipStartBytes
        this._curLine = this.options.startPadding || '';
        this._remainingBytes = null;

        this.inputBytes = 0;
        this.outputBytes = 0;
    }

    /** @internal */
    _writeChunk(chunk: Buffer): void {
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
     *
     * @internal
     */
    _emit(b64: string, final: boolean): void {
        let src = Buffer.from(this._curLine + b64, 'latin1');
        if (!src.length) {
            return;
        }

        if (!this.options.lineLength) {
            this._curLine = '';
            return this._writeChunk(src);
        }

        let { output, rest } = wrapBuffer(src, this.options.lineLength as number, final);
        this._curLine = rest ? src.toString('latin1', src.length - rest) : '';
        if (output.length) {
            this._writeChunk(output);
        }
    }

    /** @internal */
    override _transform(chunk: Buffer | string, encoding: BufferEncoding | 'buffer', done: TransformCallback): void {
        let buf = encoding !== 'buffer' ? Buffer.from(chunk as string, encoding) : (chunk as Buffer);

        if (!buf.length) {
            return done();
        }

        this.inputBytes += buf.length;

        if (this._remainingBytes) {
            buf = Buffer.concat([this._remainingBytes, buf], this._remainingBytes.length + buf.length);
            this._remainingBytes = null;
        }

        let extra = buf.length % 3;
        if (extra) {
            this._remainingBytes = buf.subarray(buf.length - extra);
            buf = buf.subarray(0, buf.length - extra);
        }

        this._emit(encode(buf), false);
        done();
    }

    /** @internal */
    override _flush(done: TransformCallback): void {
        this._emit(this._remainingBytes ? encode(this._remainingBytes) : '', true);
        this._remainingBytes = null;
        done();
    }
}

/**
 * Creates a transform stream for decoding base64 encoded strings
 */
export class Decoder extends Transform {
    options: DecoderOptions;
    inputBytes: number;
    outputBytes: number;
    /** Characters of the base64 quartet that is not complete yet @internal */
    _curLine: string;

    constructor(options?: DecoderOptions) {
        super();
        this.options = options || {};
        this._curLine = '';

        this.inputBytes = 0;
        this.outputBytes = 0;
    }

    /** @internal */
    override _transform(chunk: Buffer, _encoding: BufferEncoding | 'buffer', done: TransformCallback): void {
        if (!chunk || !chunk.length) {
            return done();
        }

        this.inputBytes += chunk.length;

        // latin1 maps every byte to one character. 'ascii' would clear the high bit of a byte, turning
        // stray 8-bit bytes into base64 characters instead of skipping them as decode() does
        let b64 = this._curLine + chunk.toString('latin1');
        this._curLine = '';

        if (/[^a-zA-Z0-9+/=]/.test(b64)) {
            b64 = b64.replace(/[^a-zA-Z0-9+/=]/g, '');
        }

        // everything up to the last padding char ends in complete segments, quartets are
        // only counted from there on as a padding run restarts the quartet alignment
        let padded = '';
        let lastPad = b64.lastIndexOf('=');
        if (lastPad >= 0) {
            padded = b64.slice(0, lastPad + 1);
            b64 = b64.slice(lastPad + 1);
        }

        if (b64.length < 4) {
            this._curLine = b64;
            b64 = '';
        } else if (b64.length % 4) {
            this._curLine = b64.slice(-(b64.length % 4));
            b64 = b64.slice(0, b64.length - this._curLine.length);
        }

        b64 = padded + b64;

        if (b64) {
            let buf = decode(b64);
            this.outputBytes += buf.length;
            this.push(buf);
        }

        done();
    }

    /** @internal */
    override _flush(done: TransformCallback): void {
        if (this._curLine) {
            let buf = decode(this._curLine);
            this.outputBytes += buf.length;
            this.push(buf);
            this._curLine = '';
        }
        done();
    }
}

// The default export is the same set of members as one object, for `import libbase64 from 'libbase64'`.
// In the CommonJS build `require('libbase64')` returns the exports object and its `.default` is that
// object itself, see scripts/build.js
const libbase64 = {
    encode,
    decode,
    wrap,
    Encoder,
    Decoder
};

export default libbase64;
