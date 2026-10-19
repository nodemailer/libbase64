# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm test` - builds `dist/` (`pretest`), then runs every `test/**/*-test.ts` with the Node.js test runner through `tsx`.
- `npm run test:coverage` - the same suite under c8, fails below the thresholds in `.c8rc.json`. CI runs it on Node 24.
- `npm run test:bun` - the same suite under Bun.
- `npm run test:fuzz` - the property tests (`test/libbase64-property-test.ts`, fast-check) with 20000 runs each. `.github/workflows/fuzz.yml` runs it weekly; replay a failure locally with the printed `FC_SEED`.
- `npm run test:cjs` - builds `dist/`, then loads the CommonJS build and exercises the main API with `--no-experimental-require-module` (`test/cjs-smoke.cjs`). CI runs it on Node 22 and 24.
- `npm run lint` - `tsc --noEmit` over `src/` and `test/`, then ESLint (`eslint.config.js`, the shared flat config also used by Nodemailer, with type-aware rules on `src/` and `no-await-in-loop` off for `test/`). `npm run lint:fix` applies autofixes.
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
- Keep the CommonJS build working, see Platform constraints below.

## Platform constraints

Both rules come from EmailEngine, which ships as a `@yao-pkg/pkg` binary: pkg snapshots a CommonJS module graph and cannot load ES modules.

- **Node.js 20 is the minimum supported version.** Runtime code, tests and tooling must work on Node 20, 22 and 24 (`engines.node` is `>=20.0.0`, `@types/node` stays on the 20.x line).
- **Everything that reaches runtime must be genuinely CommonJS-loadable.** `require()` of the CommonJS build and of every runtime dependency, transitive ones included, must work with `--no-experimental-require-module`. Node 22+ (and 20.19) can `require()` an ES module by default, which hides an ESM-only dependency until the pkg binary fails. A CommonJS entry that only wraps a dynamic `import()` does not count.
- **Check:** `npm run test:cjs`. Run it after `npm run update` or any dependency change; CI runs it on Node 22 and 24.
- There are no runtime dependencies. Should one ever be added, it must be CommonJS; never add or upgrade to an ESM-only dependency, and when a dependency's next major is ESM-only, pin the last CommonJS major in `.ncurc.cjs` (`reject`, or a `target` of `minor`/`patch`) with a comment giving the reason.

## Testing

- Tests use `describe`/`it` from `node:test` and `assert` from `node:assert/strict`. `test/libbase64-test.ts` covers the library (stream tests feed input in many chunk sizes through `runStream`, check new stream behaviour the same way), `test/package/package-test.ts` loads the built `dist/` through the exports map (including plain `node` CommonJS and ES module consumers), `test/package/types-consumer-test.ts` type-checks consumers against the built declarations.

## Release flow

Versioning and the changelog are managed by release-please via `.github/workflows/release.yaml`. Release commits look like `chore(master): release X.Y.Z [skip-ci]`. Do not bump `version` in `package.json` or edit `CHANGELOG.md` by hand. Use Conventional Commit prefixes (`fix:`, `feat:`, `chore:`, ...).

## Conventions

These mirror the conventions used across Postal Systems projects (see `../emailengine`).

**Git commits**

- Use Conventional Commits: `fix:` (patch release), `feat:` (minor release), and `chore:`/`build:`/`docs:`/`ci:`/`refactor:`/`style:`/`test:` for changes that should not trigger a release. release-please derives the version and changelog from these prefixes.
- Do **not** list Claude or any AI assistant as a co-author or co-contributor in commit messages or PR descriptions (no `Co-Authored-By` trailer).
- Append `[skip ci]` to commits that do not change runtime behavior (docs, comments, formatting) to avoid spending CI minutes. Exception: never add `[skip ci]` to a `fix:` or `feat:` commit, those must run so the release workflow triggers. Tooling changes (lint, test runner, CI) should run CI, so leave the marker off those.

**Code and docs style**

- No emojis anywhere in code or documentation, printable ASCII only.
- Use a single hyphen-minus (`-`) as a dash in user-facing strings and docs. Never use double hyphens (`--`), em dashes, or en dashes.
- devDependencies are pinned to exact versions (no `^` or `~`). The library has no runtime dependencies.

**Before committing code changes**

1. `npm run format` and `npm run lint`
2. `npm test`
3. For non-trivial changes, consider `/simplify` and `/security-review`. The decoder parses untrusted MIME input, so memory use and malformed input handling are security relevant.

**After pushing**

- Check the workflow runs for the push (`gh run list --branch <branch>`) and report their status. If a run fails for an unrelated or infrastructure reason (checkout reporting "account suspended", HTTP 403, other auth errors), check <https://www.githubstatus.com/> for an active GitHub incident before assuming the change caused it.
