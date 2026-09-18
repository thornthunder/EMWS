# nec2c: provenance and licence record

EMWS is dedicated to the public domain, so every line of code it ships has to be
public domain too, or at least compatible. This file records where the NEC2 engine
came from, the evidence for its licence status, and exactly how it is built, so that
anyone can check the claim rather than take it on trust.

Recorded by ZR1JT, 2026-09-18.

## What it is

| | |
|---|---|
| Program | **nec2c 1.3.1**, a C translation of the NEC2 FORTRAN code |
| Translator | Neoklis Kyriazis, 5B4AZ |
| Original | NEC2, the Numerical Electromagnetics Code, by G. J. Burke and A. J. Poggio, Lawrence Livermore National Laboratory, 1981 |
| Location here | [`upstream/`](upstream/), byte-for-byte as shipped, **unmodified** |

## Where it came from

Two independent copies were downloaded and compared:

| Source | File | SHA-256 |
|---|---|---|
| The author's site, `https://www.qsl.net/5b4az/pkg/nec2/nec2c/` | `nec2c-1.3.1.tar.bz2` | `8c706008bcb11c34bf33a3f8f78711c79f7bb49de8a22d74df6b10e1203c013e` |
| Debian, `https://deb.debian.org/debian/pool/main/n/nec2c/` | `nec2c_1.3.1.orig.tar.bz2` | `271bd2ea6037f896912139a66e3abb75981c72315bab5221fcf384a1736d0337` |

The archives differ only in compression metadata: after extraction, `diff -r` finds
**no differences** between their contents. The files in `upstream/` were copied from
the author's archive.

## Licence evidence

1. **The author's statement.** `upstream/README`, section 7, in full:

   > nec2c is Public Domain, same as the original FORTRAN source.
   > Please keep any software you write incorporating nec2c in Public
   > Domain or at least use an open license like GPL or BSD.

   EMWS honours that request: it is itself public domain (The Unlicense).

2. **The sources carry no licence of their own.** A search of every vendored `.c`
   and `.h` file for `GPL`, `General Public`, `licence`/`license` and `copyright`
   finds nothing. The only legal text is the original LLNL notice at the top of
   `main.c`, which is a warranty disclaimer for "work sponsored by the United States
   government", not a licence.

3. **The original is a US government work.** NEC2 was written at a US national
   laboratory and released to the public; works of the US government are not subject
   to copyright in the United States (17 U.S.C. 105).

4. **Debian's independent review agrees.** Debian's `debian/copyright` for `nec2c`
   1.3.1-3 classifies the upstream source (`Files: *`) as public domain, and only its
   own packaging (`Files: debian/*`) as GPL-2+.

### The `COPYING` file, and why it is not here

The upstream archive contains a `COPYING` file holding the GNU GPL version 3. It is
35,147 bytes of stock, unmodified FSF text that never mentions nec2c, its author or
its terms. It is the file GNU automake drops into a project automatically
(`automake --add-missing`). It contradicts the author's own explicit statement in the
README and nothing in the sources refers to it. GitHub's licence detector sees that
file and therefore labels mirrors of nec2c "GPL-3.0"; that label is an artefact.

EMWS does not vendor `COPYING`, nor the autotools machinery (`configure`,
`Makefile.in`, `aclocal.m4`, `config.guess`, `depcomp`, ...). Those scripts belong to
the FSF and carry their own licences, and EMWS does not use them: it compiles the C
files directly.

**This is a judgement, not legal advice.** It rests on the evidence above. If you need
certainty for your own use, read the sources and decide for yourself; everything
needed to do so is in this directory.

## What is vendored

All from the root of `nec2c-1.3.1/`. SHA-256 of each file as vendored:

```
6d6ef980132838372e17c5a41191e3addecb5b183ee98cd39431097fd06af0d6  AUTHORS
3278a10cd2aa9e6a0fda4565fb4eba599fb6373df6e966e52fcab8c6c602e57c  NEC2-bug.txt
8a5542b7753814265448633ac6b2fb92bb8c74aece333615a0baad2a590c6984  README
868bfecee7bbd2b1f555852b3a11f7940e732aa088a3c31a1faeb36a3d188d00  calculations.c
b337b7b7ffce60ea96bd201fd655dee229b72510e1055cab2338535f554c3f4f  fields.c
ea68f36752f769583e4cf39aefcac5fe2ad536df50069d0a14ed2ad60ff83950  geometry.c
7a3db2fba62f6b5b126eff023bb2ab4949d17f3d2a5242662baeb42d7bf7556e  ground.c
65c382d7b9e83e7ae2564b5128036f47f9ca36778167e58227240a9efee15ab4  input.c
87fd5b9e6a15224c83f7ec8692ea867501245e842d9c4f23dfe8dd8d8c5db707  main.c
8bef0d7626f6ff679fce7b908f5bd037d30d51097a0312f979387ba5b13ee293  matrix.c
a866a253acfe0daffa76170138bf24bf2019499c5ce7711e03a989eaa9a86e52  misc.c
7fd91d6d5bceccd9d63e5f7fa54636d497023849b0d2fbfe5ceaeee4edd3b286  nec2c.h
ba8825778207966f8dbd055e346d86ad1ed6106834d8631430ccdadb5bece919  network.c
9aada8c8f0ab61d86a51e753330ac2c275bdf255103ebfa160b8f3b95f7e871a  radiation.c
661f55d163d45173c14c6cb9752a5174ff4d1b7b00c347399b2541196d52ec82  shared.c
cf85bec6d95db8afdbf4dbce433aa4c1638c5c8de2b539cbbc03bc7bc094dea9  shared.h
467601c167ad0304a6ad5c7020c8ae677f76649c6ce17711ffbb5a4cd68d0799  somnec.c
```

`.gitattributes` marks `upstream/**` as `-text`, so git never rewrites line endings
and these hashes stay verifiable: `cd engines/nec2c/upstream && sha256sum *`.

## What EMWS adds

- [`wasm/config.h`](wasm/config.h): a stand-in for the autotools-generated header,
  supplying the one macro the sources use (`PACKAGE_STRING`). By ZR1JT, public domain.
- [`/scripts/build-nec2c.mjs`](../../scripts/build-nec2c.mjs): the build script, with
  every compiler flag and the reason for it. By ZR1JT, public domain.

No upstream file is patched. If a fix to nec2c is ever needed, keep `upstream/`
pristine and add the change as a separate, documented patch file applied at build time.

## The build that is committed

`npm run build:engine` compiles `upstream/*.c` to WebAssembly. The result is committed,
so that contributors do not need Emscripten to work on EMWS:

| File | Bytes | SHA-256 |
|---|---|---|
| `src/engine/nec2/wasm/nec2c.wasm` | 258,684 | `d1d95e600d33da81e631be1909e3fd44c66c710407f4988df39225e122e955ed` |
| `src/engine/nec2/wasm/nec2c.mjs` | 60,641 | `369d6ecd8ba857444cd3d144f5dcb136fa2e859f074854f3b6cd3457a54dba33` |

These are the hashes of the files **as stored in git**. `nec2c.mjs` is text, so git keeps
it with LF line endings whatever platform built it (Emscripten on Windows writes CRLF,
which makes the working copy differ). To check a checkout on any platform:

```sh
git cat-file blob HEAD:src/engine/nec2/wasm/nec2c.wasm | sha256sum
git cat-file blob HEAD:src/engine/nec2/wasm/nec2c.mjs  | sha256sum
```

Built with **Emscripten 6.0.9** on Windows x64. A different Emscripten version will
produce different bytes; the test suite (`npm test`), which checks the engine's numbers
against antenna theory, is what says whether a rebuild is good.

`nec2c.mjs` is generated by Emscripten and contains its JavaScript runtime support
code, which is MIT-licensed; the compiled module also links Emscripten's C library
(musl, MIT). These are permissive licences whose notices ship with Emscripten; see
[`/README.md`](../../README.md#licence).

## Updating nec2c

1. Download the new archive from the author's site **and** a second independent mirror;
   compare them.
2. Re-check the licence statement in its README and search the sources for licence text.
3. Replace the files in `upstream/`, leaving out `COPYING` and the autotools files.
4. `npm run build:engine && npm test && npm run build`, then run the browser smoke test.
5. Update the hashes and versions in this file.
