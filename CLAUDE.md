# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` - builds `dist/` (`pretest`), then runs every `test/**/*-test.ts` with the Node.js test runner through `tsx`.
- `npm run test:coverage` - the same suite under c8, fails below the thresholds in `.c8rc.json`. CI runs it on Node 24.
- `npm run test:bun` - the same suite under Bun.
- `npm run lint` - `tsc --noEmit` over `src/` and `test/`, then ESLint (`eslint.config.js`, type-aware rules on `src/`).
- `npm run format` / `npm run format:check` - Prettier (`.prettierrc`).
- `npm run build` - produces `dist/` (also runs on install and before publish through `prepare`).
- Single file: `node --import tsx --test test/libbase64-test.ts`, filter with `--test-name-pattern 'Decoder'`.
- `npm run update` - wipes `node_modules` and `package-lock.json`, runs `ncu -u` (config in `.ncurc.cjs`), then reinstalls. Use only for a deliberate dependency refresh.

## Architecture

`libbase64` is a small base64 codec used by Nodemailer, libmime, mailsplit/mailparser, ImapFlow, WildDuck and EmailEngine for MIME bodies, so output compatibility matters. It is written in TypeScript in a single file, `src/libbase64.ts`, and published as a dual package: ES modules in `dist/esm/` and CommonJS in `dist/cjs/`, each with type declarations. Node.js 20 or newer (`engines.node`). No runtime dependencies; keep it that way.

Exports: `encode`, `decode`, `wrap`, `Encoder`, `Decoder`, the `EncoderOptions`/`DecoderOptions` types, and a default export object with the five runtime members.

Invariants that span several functions:

- **`Encoder` output equals `wrap(encode(input), lineLength)`** regardless of chunking. It holds up to 2 leftover input bytes (`_remainingBytes`) so only complete 3-byte groups are encoded, and keeps the incomplete output line (`_curLine`) so only the last line, emitted in `_flush`, lacks a trailing CRLF. `wrap()` and `Encoder` share `wrapBuffer()`. `skipStartBytes`, `limitOutputBytes` and `startPadding` apply to the wrapped output (WildDuck uses them to serve byte ranges of encoded attachments). The misspelled `limitOutbutBytes` stays accepted.
- **`wrap()` has two paths**: a Buffer-based path for plain base64 strings, and `legacyWrap()` for input with line breaks, non-latin1 characters or surrounding whitespace (historical line based behaviour).
- **`decode()` handles several padded segments** (eg. every line padded on its own), because `Buffer.from(str, 'base64')` stops at the first `=`. All segments are written into one preallocated buffer to keep memory proportional to the input; a test runs this in a child process with a 128 MB heap.
- **`Decoder`** reads chunks as latin1, strips everything outside `[a-zA-Z0-9+/=]`, passes everything up to the last `=` straight to `decode()` (a padding run restarts quartet alignment), and carries an incomplete quartet to the next chunk or `_flush`.

Nodemailer has its own copy of the encoder (`../nodemailer/src/base64/`), a fix in one usually applies to the other.

## Build and module format

- `scripts/build.js` compiles `src/` twice (`tsconfig.esm.json`, `tsconfig.cjs.json`), writes a `package.json` with the module format into each output directory, and rewrites the CommonJS output so `require('libbase64')` returns the exports object (same members as the pre-TypeScript `module.exports`) whose non-enumerable `.default` is the object itself. A module with a default export not listed in `CJS_SHIMS` fails the build.
- `package.json` `exports` maps `.` to both builds and `./lib/*` to the matching file under `dist/`, so the old `require('libbase64/lib/libbase64')` deep import keeps resolving.
- Source must compile both ways: no `import.meta`, `require`, `module`, `__dirname`, top-level `await` or JSON imports under `src/`. Relative imports carry the `.js` extension. `erasableSyntaxOnly` and `exactOptionalPropertyTypes` are on.
- EmailEngine bundles its dependencies with `@yao-pkg/pkg`, which only follows `require()`. Keep the CommonJS build working.

## Testing

- Tests use `describe`/`it` from `node:test` and `assert` from `node:assert/strict`. `test/libbase64-test.ts` covers the library (stream tests feed input in many chunk sizes through `runStream`, check new stream behaviour the same way), `test/package/package-test.ts` loads the built `dist/` through the exports map (including plain `node` CommonJS and ES module consumers), `test/package/types-consumer-test.ts` type-checks consumers against the built declarations.

## Release flow

Versioning and the changelog are managed by release-please via `.github/workflows/release.yaml`. Release commits look like `chore(master): release X.Y.Z [skip-ci]`. Do not bump `version` in `package.json` or edit `CHANGELOG.md` by hand. Use Conventional Commit prefixes (`fix:`, `feat:`, `chore:`, ...).
