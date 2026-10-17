# rag.js

A single-file JavaScript RAG library for Deno and Bun. Import `rag.js` by a local
path, use its npm package, or use an immutable HTTPS URL in Deno. No consumer
package.json, deno.json or import map is required for the standalone file.
Each instance has its own storage directory and an optional root for relative
paths.

**Status: v0.3.0.** Turso Database is the supported backend.
Search runs independently of ingestion, with background refresh by default and
scoped priority waits. The native-record schema replaces the prototype snapshot;
use fresh storage for this release. Other targets have published native packages
but have not been runtime-tested here.

The verified runtimes are Deno 2.9.7 and Bun 1.4.3 on Windows x64. Media resource
management uses JavaScript `using` / `await using`; older runtimes are unverified.
This release does not claim Node.js support.

Development preferences: [DEV_PREF.md](DEV_PREF.md). Project instructions:
[AGENTS.md](AGENTS.md). Development decisions, verification procedures and
experiment interpretation are consolidated in AGENTS.md; reports/ retains JSON
evidence.

## Installation

With Deno, import the published npm package or the tagged standalone module:

```js
import { Rag } from "npm:@mefistofelix/rag.js@0.3.0";
// Or:
// import { Rag } from "https://raw.githubusercontent.com/mefistofelix/rag.js/v0.3.0/rag.js";
```

With Bun:

```sh
bun add @mefistofelix/rag.js@0.3.0
```

```js
import { Rag } from "@mefistofelix/rag.js";
```

Both runtimes can also run a locally copied rag.js without an application
manifest. Bun resolves the pinned npm providers through its native auto-install;
Deno uses its npm resolver. Providers remain lazy. The publisher's package.json
declares exact dependency versions for installed consumers; it is not required
by a standalone consumer. Package managers may download native dependencies at
installation time. Models are not bundled and providers initialize only on use.

License: [MIT](LICENSE).

## Quick start

```js
import { Rag } from "./rag.js";

const rag = await Rag.init({
  rootDir: "/data/project",
  storageDir: "./.rag",
  storage: {
    driver: "turso",
  },
});

try {
  const source = await rag.addFolder("documents", {
    include: ["**/*"],
    exclude: ["**/temporary/**"],
  });

  const report = await rag.index();
  const result = await rag.search("contract renewal", {
    mode: "hybrid",
    scope: {
      sourceIds: [source.id],
      include: ["documents/**/*.pdf"],
      mime: ["application/pdf"],
    },
    refresh: "none",
    limit: 10,
  });
  console.log(report, result.hits);
} finally {
  await rag.close();
}
```

Run without manifests:

```sh
deno run --no-config --node-modules-dir=auto --allow-read --allow-write --allow-env --allow-net --allow-ffi app.js
```

Native npm bindings require local node_modules and FFI permission. Deno's module
cache/node_modules are runtime-managed and separate from instance storage. Model
network access is lazy. Narrow permissions to the paths/hosts used by your app.
The Windows development bootstrap uses `-A` for explicit native experiments.

For Bun, run `bun run app.js`; Deno permission flags do not apply to Bun.

Required targets: **Windows x64, Linux x64/ARM64, macOS ARM64**. Windows ARM64
and macOS x64 are out of scope. Linux support currently means the published
glibc packages; do not assume that every optional provider supports musl.

## Public API

All operations return promises. Each instance owns one extraction/update loop
and optionally one watch loop. Search does not wait behind ingestion; short
native database operations and per-document publication are synchronized. Source
registration is runtime-only and does not start indexing. Resupply sources after
reopening. close() stops the loops and releases native resources; a running
native call may finish before cancellation is observed.

| Method                                                  | Behavior                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Rag.init(options)`                                     | Resolve directories, acquire an exclusive storage lock, open Turso Database; reject legacy stores without conversion. |
| `addFolder(path, options)`                              | Register a runtime source; identical canonical path and options are idempotent. Returns `{ id, path }`.               |
| `listFolders()`                                         | Return runtime folders and selection options.                                                                         |
| `removeFolder(sourceId)`                                | Remove source memberships; preserve documents still referenced through another source. Never delete originals.        |
| `index(options)`                                        | Reconcile the selected scope and await its required per-document updates.                                             |
| `reindex({ from, ...options })`                         | Rebuild from `extract`, `chunks` or `embeddings`; `indexes` rebuilds physical indices globally without re-extraction. |
| `search(query, options)`                                | Full-text, exact cosine vector or hybrid search, returning deduplicated chunks and filtered citations.                |
| `listDocuments(options)`                                | Page document records by scope, limit and after cursor.                                                               |
| `addUserMeta(options)`                                  | Create a textual note/tag/field and optionally link it to document IDs.                                               |
| `updateUserMeta(id, changes)`                           | Edit a shared authored record and schedule affected docs.                                                             |
| `linkUserMeta(docId, id)` / `unlinkUserMeta(docId, id)` | Add/remove one document/value association.                                                                            |
| `removeUserMeta(id)` / `listUserMeta(options)`          | Explicitly delete a user value, or list/filter its native full-text matches.                                          |
| `embed(texts, options)`                                 | Xberg embeddings for nonempty strings; role is `query` or `document`. Returns `{ spaceId, vectors }`.                 |
| `transcribe(input, options)`                            | Direct audio or video-audio transcription with the same provider/hook as ingestion. No implicit indexing.             |
| `ocr(input, options)`                                   | Direct image OCR with the same provider/hook as ingestion.                                                            |
| `status()`                                              | Versions, counts, states, limits, provider coverage, storage capabilities and document errors.                        |
| `gc()`                                                  | Remove unreachable derived data when ingestion is idle; preserve user-authored values.                                |
| `watch(options)`                                        | Start a debounced filesystem reconciliation watcher; returns `{ close() }`.                                           |
| `close()`                                               | Idempotently close watchers, provider resources, storage and the writer lock.                                         |

`rootDir` defaults to the current working directory captured at init. Relative
storageDir, source paths, direct transcription paths and query globs use that
root. Source include/exclude globs are relative to the source directory.
Absolute paths and file: URLs are accepted for local inputs. HTTP ingestion is
not implicit.

Input for direct OCR/transcription is a path, file: URL, or
`{ bytes: Uint8Array, mime?, filename? }`. Byte inputs needing a decoder are
materialized temporarily under storageDir/tmp and removed afterwards.

## Indexing limits and video

Limits belong to instance configuration so they have an explicit
extraction-cache signature. Reopen with different limits to change policy;
index() accepts scope, verify, signal and onProgress, rather than a second
mutable provider configuration.

```js
const rag = await Rag.init({
  storageDir: "./.rag",
  indexing: {
    maxFileBytes: 64 * 1024 * 1024,
    maxPages: 500,
    maxArchiveBytes: 256 * 1024 * 1024,
    maxArchiveEntries: 1000,
    maxArchiveDepth: 3,
    audio: {
      maxFileBytes: 256 * 1024 * 1024,
      maxDurationSeconds: 2 * 60 * 60,
    },
    video: {
      maxFileBytes: 1024 * 1024 * 1024,
      maxDurationSeconds: 2 * 60 * 60,
      transcribe: true,
      ocr: {
        intervalSeconds: 30,
        maxFrames: 120,
        maxWidth: 1600,
      },
    },
  },
});
```

These are the current defaults. Audio/video byte limits override the general
non-media file limit. They measure compressed input bytes, not decoded PCM size.
Known duration is checked before model work; audio with unknown duration is
bounded while decoding. Video OCR requires a known duration for whole-clip
sampling. A decoder probe may read headers before the media-specific byte limit
is known.

Elementary MPEG video is recognized by its byte signature. When the container
does not report a duration, compressed packet timestamps are scanned to
establish one without decoding frames or guessing a frame rate. Truly unknown
timelines still receive UNKNOWN_DURATION for OCR sampling.

Video has two independent channels:

- Whisper transcribes the audio stream, preserving the original language.
- OCR reads sampled video frames, not every frame. Effective interval is at
  least intervalSeconds and grows to fit the whole video within maxFrames.
  Frames are downscaled only when wider than maxWidth. Set `video.ocr: false` to
  disable it.

Citations identify channel `audio` or `video-ocr` and timestamp bounds in
seconds. Repeated frame text shares chunks while retaining each sampled
occurrence. Sampling metadata is retained. A file exceeding a hard byte/duration
limit gets state `skipped` and a reason such as MAX_FILE_BYTES/MAX_DURATION; it
is not silently truncated and published as complete. A skipped or failed
revision is not searchable.

Xberg enforces maxPages on the formats supported by its public SecurityLimits
API; this does not establish a page-count limit for formats without fixed pages.
Archive bytes/entry/depth limits are delegated to Xberg. Partial envelope errors
fail extraction instead of publishing only a successful fragment.

Archive document leaves are indexed from Xberg's structured children, preserving
page numbers and the nested archive-relative path chain in
`citation.locator.entries`. Identical text in separate entries shares chunks
while retaining every occurrence. The archive's file listing and aggregated
wrapper text are not indexed as another document body. Citation MIME and query
MIME filters describe the physical source file; leaf MIME is retained in the
locator. Native NodeAV audio/video channels currently apply to standalone media
files; archive contents use Xberg's document-extraction capabilities.

## OCR, transcription and multilingual behavior

OCR defaults to **PaddleOCR inside Xberg**, using PP-OCRv6 small. No separate
OCR runtime dependency is added. `ocr.languages: "auto"` selects its unified
**50-language profile: Simplified/Traditional Chinese, English, Japanese and 46
Latin-script languages**, including Italian. This is finite model coverage, not
script/language autodetection. Russian, Arabic and other scripts outside the
unified model require explicit languages such as `"rus"` or `"ara"`.

```js
ocr: {
  mode: "paddle",
  languages: "auto", // or e.g. "rus", "ara", "latin", "ch"
  paddle: {
    modelVersion: "pp-ocrv6",
    modelTier: "small",
  },
  acceleration: { provider: "cpu" },
}
```

Xberg 1.3.10 selects one Paddle recognition model per call. A language array
does not enable script autodetection: requests spanning unsupported families
emit warnings and can drop text. Explicit Arabic/Cyrillic requests select
separate recognition models. PP-OCRv6 tiny and v5 require explicit languages;
they cannot silently reuse the documented auto profile. The Arabic fixture still
exposed a reading-order problem even with an explicit model. See
[OCR/GPU measurements](reports/gpu-ocr-2026-10-15.json).

```js
ocr: {
  mode: "tesseract",
  languages: "auto", // finite Latin+Cyrillic+Arabic+Simplified Chinese profile
}
```

Tesseract remains available with a per-instance tessdataPath. `Latin` is its
script model, not `lat` (the Latin language). Other scripts can use explicit
traineddata model names. No process-wide TESSDATA_PREFIX changes are made. OSD
misclassified a mixed Latin fixture and is not used as a universal selector.
Optional AutoJS mode `native` uses OS OCR; mode `auto` retains its existing
native-then-Tesseract-on-null behavior, with OS-dependent language coverage.
This mode selector differs from the `languages: "auto"` coverage policy.

Paddle model files are isolated under storageDir/models/paddle. Direct image
OCR, scanned-document OCR and sampled video OCR use this configuration and the
same callback. Provider warnings remain visible; nonempty output is not proof of
correct recognition.

PDF OCR uses Xberg's page-quality policy: usable native text is extracted
directly, and a full-page image is skipped when the page already has extracted
text. Smaller illustrations can still contribute new OCR text. Mixed PDFs are
handled per page; an unusable or near-empty text layer can still trigger OCR.
PNG/JPEG ingestion retains metadata returned by the built-in OCR extraction in
locator.metadata; custom hooks may return metadata too. Detected document MIME
and metadata come from content-aware extraction, not just filename extensions.

Transcription initially uses **node-av 6.1.1**, combining native FFmpeg decoding
with Whisper. This keeps audio/video decoding and inference in one binding. The
first implementation supports node-av/auto or a callback; Sherpa remains an
investigated alternative, not an implemented provider in this release.
Transformers.js is not imported or used as an embedding/transcription provider.

```js
transcribe: {
  enabled: true,
  provider: "node-av",
  model: "tiny",
  language: "auto",
  useGpu: false,
  threads: 4,
  // modelPath: "/models/ggml-base.bin", // explicit model for other sizes
}
```

Default tiny GGML model downloads are revision-pinned and SHA-256 checked. An
explicit modelPath is copied into instance storage; choose a multilingual model
without the .en suffix for autodetect. The tested native CPU path supports WAV
PCM16, MP3, FLAC, Ogg Vorbis, M4A AAC, WebM Opus and MP4 video audio. This is
not a guarantee for every codec/container combination or long/noisy recordings.
The provider uses NodeAV's public Whisper filter with an explicit thread budget.
Its convenience transcriber does not expose filter-graph threads. Auto/16-thread
inference was dramatically slower on the tested CPU; 4 is a conservative
default, not a claim that one setting is optimal on every machine. Each
transcription creates a native context; resident Whisper-context pooling is not
implemented.

`transcribe.useGpu: true` and optional `gpuDevice` are forwarded to the public
Whisper filter. Actual Vulkan inference was verified on the Windows RTX 3050; an
OpenCL warning about an unsupported GPU does not establish Vulkan failure. Warm
36.6-second synthetic audio took 0.94 s on Vulkan versus 3.70 s on CPU; the
first short GPU call was slower because of initialization. These are local
timings, not a guarantee that every recording is faster or equally accurate.

Embedding acceleration is also exposed through Xberg's existing public API:

```js
embedding: {
  model: "multilingual",
  acceleration: { provider: "cpu", deviceId: 0 },
}
```

Xberg accepts `auto`, `cpu`, `cuda`, `coreml` and `tensorrt` provider names.
This does not establish that a particular prebuilt package implements them. With
@xberg-io/xberg 1.3.10 on Windows x64, explicit CUDA requests for both
embeddings and PaddleOCR fail with **compiled without CUDA support**, including
when a portable GPU-enabled ONNX Runtime is provided. Installing CUDA DLLs alone
cannot add the missing build feature. The current default therefore remains CPU
here; requesting `auto` does not prove GPU execution. Other platforms' GPU
execution has not been tested. No extra embedding pipeline or Transformers.js is
used. Embedding failures include the native provider warning in their error
message.

```js
const result = await rag.transcribe("recordings/meeting.mp4", {
  language: "auto",
  signal,
});
// { text, segments: [{ start, end, text }], provider, model,
//   language: { requested }, warnings }
```

Segment times are seconds. A detected language is not fabricated: the selected
NodeAV API does not expose it here, so requested is distinct from detected. A
video without audio returns empty text and a warning. Direct methods do not
register sources or write document records. Set ocr/transcribe to false to
disable.

Current Xberg Whisper falls back to English for omitted/unknown language codes;
that path is not used for generic automatic transcription. See the recorded
[language and format experiments](AGENTS.md#recorded-measurements-and-interpretation).

## Hooks and provider boundaries

OCR and transcription accept an options object, an async callback, or false.
Extraction and embedding also support callbacks for integrations and core tests.
Callbacks receive plain values and an explicit built-in delegate:

```js
const rag = await Rag.init({
  storageDir: "./.rag",
  ocr: async (request, next) => {
    // request: { input: { bytes, mime, filename }, options, document?, signal? }
    if (customOcrCanHandle(request)) {
      return { text: await customOcr(request), provider: "custom" };
    }
    return await next(request);
  },
  transcribe: async (request, next) => {
    // input has path OR bytes; options include language/model/provider.
    return await next(request);
  },
  hookVersion: {
    ocr: "custom-ocr-v1",
    transcribe: "custom-asr-v1",
  },
});
```

OCR/transcription results require `{ text }`; transcription may add segments,
provider, model, language and warnings. null deliberately skips that operation.
Errors propagate to direct callers or become per-file index errors. next accepts
a replacement request; it never re-enters the user hook. For extraction return
`{ mime, units: [{ text, locator? }], provider?, warnings? }`, or null to skip.
Embedding receives `{ texts, role, model, signal }` and returns `{ vectors }`.

Hooks must be supplied again on reopen. A missing hookVersion gets a per-open
identity, preventing unsafe persistent reuse. Explicit versions describe
behavior; functions/closures are not serialized. Xberg hook names are unique per
instance and unregistered individually. Native work checks cancellation between
operations; a signal does not guarantee interruption in the middle of a native
inference call.

Use next() inside a hook and the supplied payload inside onProgress. Calling
public methods on the same instance from a provider hook is rejected with
REENTRANT_CALL; use next() and request data. onProgress runs during
reconciliation and may query status. Delegation to a separate instance is
supported.

Extraction cache context is explicit: built-in providers include the filename;
custom OCR/transcription/extraction hooks include the full path by default,
because a callback may use document context. Set
`cache: { extractionContext: "content" }` only when extraction is independent of
the path/name (the extension and detected MIME still participate). `filename`
and `path` are also accepted. Chunk/vector deduplication remains content-based
regardless. Optional native OS OCR gets a per-open profile identity unless an
explicit ocr.profileVersion is supplied, since OS language packs can change.

## Search scope and freshness

```js
const result = await rag.search("contract renewal", {
  mode: "hybrid", // "fulltext", "vector", "auto"
  refresh: "background", // default; also "wait" or "none"
  verify: "metadata", // or "hash"
  scope: {
    include: ["documents/**/*.pdf"],
    // paths: ["documents/literal[1].pdf"],
    // sourceIds: [source.id],
    mime: ["application/pdf"],
    // kinds: ["text", "note"],
    // origins: ["ocr", "asr"],
    // languages: ["it", "en"],
  },
  limit: 10,
  signal,
});
console.log(result.hits, result.freshness, result.refresh?.errors);
```

| refresh             | Behavior                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| background, default | Verify matching files and schedule new/changed/absent or already-stale docs. Return currently published results without waiting for extraction. |
| wait                | Same verification; prioritize the affected docs and wait for those dependencies before searching. Unrelated queued work is not awaited.         |
| none                | Query the existing index; no filesystem freshness checks or new scheduling from this request. Other already-pending work continues.             |

The single ingestion worker chooses docs needed by active wait searches first,
FIFO within each priority class. It finishes a running native operation before
switching. A new revision of a running document rejoins behind already queued
documents in its priority class. Multiple waiters share work and reference-count
priority. Aborting a request releases its priority without cancelling work
shared with other callers.
If a target changes while another target is still pending, the wait includes
its newer revision too.
If an affected file fails, exceeds limits or cannot be verified, wait returns
available hits with freshness.complete=false and an explicit refresh.errors
report. It does not wait indefinitely for retries.

freshness contains checked, staleDetected, pending and complete. Counts describe
the requested scope and observations; work may finish before results are built.
none reports checked=false and complete=null because the filesystem was not
verified. Existing published content remains searchable while stale, with
citation.stale=true; a new unprocessed file has no content hit yet.

Relative paths/globs resolve against rootDir. Exact paths preserve literal glob
characters. Path/source/MIME filters intersect; values within each filter are
OR. MIME is content-based where detected; unknown candidates are not excluded
solely by an untrusted extension. Kinds/origins/languages filter occurrences,
including citations, before final result limits. Source options are copied and
their globs compiled at registration; patterns resolve against the source's own
directory. Query filters do not register permanent sources. No
explicit scope searches all indexed docs and reconciles registered folders plus
known indexed paths; discovering new files requires a registered folder.

index() reconciles and waits for its own scope. It accepts scope, verify, signal
and onProgress; progress reports discovery/scheduling, while the returned report
counts settled updates. The old index refresh option is rejected. Search's old
missing/sync options are replaced by background/wait/none. Metadata verification
trusts unchanged size/mtime and pipeline identity. verify=hash rereads original
bytes, detecting same-size edits with preserved mtime. Watch hints request hash
verification for affected known files. Limits are checked before model work.

Full-text treats terms as literals combined with OR. Vector search uses exact
cosine in the current compatible embedding definition. Hybrid uses reciprocal
rank fusion, k=60, with four-times-limit candidates per branch. auto chooses
hybrid when the current embedding definition has stored vectors; otherwise
fulltext. Hybrid does not guarantee better relevance.

## User notes, tags and fields

```js
const { documents } = await rag.listDocuments({
  scope: { include: ["documents/**/*.pdf"] },
  limit: 100,
});
const note = await rag.addUserMeta({
  type: "note",
  value: "Review the renewal clause",
  documentIds: documents.map((doc) => doc.id),
});
await rag.updateUserMeta(note.id, { value: "Renewal clause reviewed" });
const values = await rag.listUserMeta({ type: "note", query: "renewal" });
await rag.search("renewal", { refresh: "wait", scope: { kinds: ["note"] } });
```

addUserMeta returns `{id}`. Values are text, with a native full-text index on
user_meta.value. Types include note/tag and application-defined strings. Editing
a shared record affects all linked docs. linkUserMeta(documentId, id) and
unlinkUserMeta(documentId, id) change associations; removeUserMeta(id)
explicitly deletes a value and its associations. Reindex and GC never delete
authored values merely because they are unlinked.

Edits/links mark affected docs stale and schedule derived note/tag chunks and
embeddings. Unchanged file extraction is reused. listUserMeta sees authored
changes immediately; search sees the last published derived text until the
worker updates it. Note citations carry userMetaId and origin=manual.
listDocuments returns `{documents, after}` for keyset paging; pass after into
the next call. Rows contain root-relative paths and publication/stale fields.

## Storage, worker and recovery

Each storageDir contains turso.db, writer.lock, models/ and tmp/. One instance
owns the directory at a time. The database has six application tables:

| Table             | Purpose                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| docs              | Physical root-relative paths, fingerprints, published extraction reference and stale flag.             |
| docs_data         | Immutable full extraction body, unit structure, generated metadata, language information and warnings. |
| docs_chunks       | Shared chunk text, input/model identity and native vector in the same row.                             |
| docs_chunks_links | Many-to-many document/chunk occurrences, preserving order, pages, timestamps, languages and origins.   |
| user_meta         | Shared user notes/tags/fields with full-text search.                                                   |
| docs_user_meta    | Many-to-many document/user-value associations.                                                         |

There are no chunks, embeddings, embedding_spaces, chunk_embeddings, sources,
jobs or instance-state tables, no whole-catalog JSON and no migration manager.
Turso creates its own native index structures; query scope uses a temporary
connection-local table.
[Column meanings and relationships](AGENTS.md#column-dictionary) are recorded in
the project handoff.

One extraction loop consumes coalesced in-memory work. When empty, it reads
bounded pages of docs.stale and updates eligible docs; otherwise it sleeps until
woken or worker.idleMs (default 1000). Failed/skipped docs retain stale with
runtime-only retry backoff worker.retryMs (default 30000). Explicit index
retries them. The optional watch loop uses the same scheduler. Start watch after
registering folders; restart it if the folder list changes. A watch handle's
close() is idempotent.

Folders/globs, queue, priorities, retries and diagnostics live in instance
memory. Resupply sources after reopening; stale docs recover without another
watch event. Watch is not a filesystem journal: changes made while closed need
reconciliation. Storage is excluded from ingestion; symlinks are not followed.
Incomplete traversal suppresses absence pruning. Removing a folder preserves
docs still selected through overlapping runtime folders and never deletes files.

Each doc publishes chunks, vectors, all occurrence links and its extraction
reference in one Turso transaction. Other docs may finish separately; no global
generation exists. Rollback preserves previous published content. Extraction
artifacts prepared before publication can be orphaned; gc() removes unused
derived data only when ingestion is idle, otherwise rejecting with WORK_PENDING.
Actual abrupt power-loss durability has not been certified.

v0.1 snapshot stores are rejected with LEGACY_STORAGE. Choose a fresh
storageDir; there is no automatic conversion or deletion. A crash can leave
writer.lock; verify no process owns that storage before removing only the stale
lock manually.

## Dependencies

Imports are lazy except Node compatibility primitives built into both runtimes.
Turso Database is the sole runtime backend.

| Purpose                                                  | Exact import                             |
| -------------------------------------------------------- | ---------------------------------------- |
| Document extraction, Paddle/Tesseract OCR and embeddings | npm:@xberg-io/xberg@1.3.10               |
| Audio/video decoding and Whisper                         | npm:node-av@6.1.1                        |
| Optional OS OCR                                          | npm:@mefistofelix/auto.js@0.1.5          |
| Turso Database                                           | npm:@tursodatabase/database@0.8.3        |
| Glob compilation in Deno                                  | jsr:@std/path@1.1.6/posix/glob-to-regexp |
| Glob matching in Bun                                      | Built-in Bun.Glob                       |

No npm picomatch or ignore is used. Deno also includes node:path.matchesGlob and
node:fs/promises.glob; the standard glob compiler and Bun.Glob keep hidden-file
selection separate from matching. Bun uses the same exact package versions in
its native `package@version` import syntax, without the Deno `npm:` prefix.
[Official glob examples](https://docs.deno.com/examples/glob_patterns/). Full
.gitignore parsing is not part of @std/path. gitignore=true is explicitly
rejected; use include/exclude until an optional provider is implemented.

All import declarations and optional module loaders are grouped at the beginning
of rag.js. Native providers remain lazy; importing the library does not open a
database, create storage or initialize a model.

### Experimental Indra OCR

[tests/indra.js](tests/indra.js) provides an opt-in OCR hook using native
`npm:onnxruntime-node@1.30.0` and `npm:sharp@0.35.3` for image decoding. It is a
test integration, outside the single-file distribution. It uses pinned,
SHA-256-verified Indra ONNX weights and stores them under storageDir/models.
Paddle remains the production default. Embeddings still use Xberg.

```javascript
import { Rag } from "./rag.js";
import { createIndra } from "./tests/indra.js";

const storageDir = "./experimental-index";
const engine = await createIndra({ storageDir, provider: "cpu", threads: 4 });
const rag = await Rag.init({
  storageDir,
  ocr: engine.hook,
  hookVersion: { ocr: engine.hook.version },
});
try {
  console.log(await rag.ocr("./scan.png"));
} finally {
  await rag.close();
  await engine.close();
}
```

The hook also receives scanned PDF pages and sampled video frames through the
existing OCR path. Xberg handles PDF text-layer routing; short/unusable text
layers may still trigger OCR. Indra JS supports line detection, orientation,
width-batched recognition and per-line Chinese routing. It omits upstream
deskew, learned reading order, table/layout assembly and math reconstruction.
Orientation is imperfect, especially on wide pages. Script routing does not
detect document language. OCR covers Latin, Cyrillic, Greek, Devanagari, Bengali
and Chinese; Arabic, Hebrew, Japanese kana and Korean Hangul are unsupported.
Only the existing Latin/Russian/Chinese fixtures have been exercised here.

`provider: "dml"` requests Windows DirectML. Native CPU inference and DirectML
were executed on Windows x64; this experiment has not run on Linux/macOS. ORT
may assign individual nodes to CPU. The Windows npm prebuild does not bundle
CUDA. DirectML was slower than CPU on these small fixtures.
[Pinned ORT platform matrix](https://github.com/microsoft/onnxruntime/blob/v1.30.0/js/node/README.md).

Indra source is Apache-2.0; its weights use a modified OpenRAIL-M license with
commercial and competitive-use restrictions. Review the
[model license](https://huggingface.co/datalab-to/indra-ocr/blob/ed345c7f158eddbc7dee0c6a7269afb75a94f7e8/LICENSE)
before adopting it. The experimental hook retains the upstream code license in
[tests/indra-LICENSE.txt](tests/indra-LICENSE.txt).

Reproduce with `build.bat fixtures`, `build.bat native`,
`build.bat indra-reference`, `build.bat benchmark indra` and
`build.bat indra-report`. The optional reference uses uv-managed Python and
official indra-ocr==0.3.2; Python is not required by the JS hook or rag.js. All
Python installations/caches stay under build/.
[Experimental results](reports/indra-2026-10-16.json) compare ten public clean
print fixtures and three-document ingestion without embeddings. They do not
measure OmniParseBench or the private 2.51 GB corpus.

The [extended default-selection check](reports/indra-quality-2026-10-16.json)
adds unseen legal text, skew, rotation, small/blurred/faded images and a
Japanese control. Indra JS was faster (85 vs 284 ms median warm OCR), but
preserved exact normalized text in 13/21 cases versus 18/21 for Paddle, and
retained 55/81 phrases/identifiers versus 70/81. Its missing deskew causes
inclined-page errors; Japanese OCR is unsupported. The complete Python Indra
oracle fixes the skew cases, but is not the shipped JS hook. **Paddle remains
the default** on this evidence. These synthetic diagnostics are not general OCR
accuracy estimates. Reproduce with `build.bat benchmark indra-quality`,
`build.bat indra-reference build/indra-quality/fixtures/manifest.json build/indra-quality/python-reference.json`,
then `build.bat indra-quality-report`.

### Experimental FastEmbed comparison

The default embeddings still use Xberg's multilingual E5-base path. A separate
[FastEmbed experiment](reports/fastembed-2026-10-16.json) compares identical
E5-base weights/tokenizers through fastembed@3.0.0 on CPU and Windows DirectML,
plus its smaller English default preset. No extra embedding dependencies were
added to rag.js.

On 28 public text files and 54 IT/EN/RU/ZH/JA queries:

| Provider                           |    Indexing | Live vector query median | Relevant topic at rank1 |
| ---------------------------------- | ----------: | -----------------------: | ----------------------: |
| Xberg CPU, multilingual E5-base    |      1.51 s |                    35 ms |                    100% |
| FastEmbed CPU, same E5-base        |      8.42 s |                   281 ms |                    100% |
| FastEmbed DirectML, same E5-base   | about 1.9 s |              about 60 ms |                    100% |
| FastEmbed CPU, English BGE default |      4.43 s |                   138 ms |                     52% |

There is a useful GPU exception: indexing 16 longer files into 32 chunks with
the normal 1200-character chunker took about 1.88 s through FastEmbed DirectML
versus 5.94 s through Xberg CPU. Equivalent E5 vectors and truncation were
verified. This supports further work on an optional GPU path for long text;
short queries remain faster on Xberg CPU. These small authored fixtures do not
establish general retrieval accuracy or full-corpus timings.

The FastEmbed test hook is outside the single-file distribution. Its archived
native tokenizer dependency lacks Linux ARM64 prebuilds, and FastEmbed3 exposes
no public session disposal API; tests isolate it in disposable child processes.
Other platforms and GPU node placement have not been verified. Production
adoption therefore remains open.

Reproduce sequentially with `build.bat benchmark fastembed`,
`build.bat fastembed-gpu`, `build.bat fastembed-long`, then
`build.bat fastembed-report`. Models, logs and vectors stay under
build/fastembed-test; the report contains public-fixture aggregates and hashes.

## Development and tests

```bat
build.bat test
build.bat native
build.bat glob
build.bat benchmark storage current
build.bat benchmark quality current
build.bat benchmark primitives current
build.bat benchmark asr
```

The bootstrap installs only portable Deno/FFmpeg under tools/ and stores caches,
fixtures, model downloads and test output under build/. The existing dependency
matrix remains available with `build.bat all`; it is separate from core tests.
See [verification instructions](AGENTS.md#verification-and-reproduction) for
setup and the older experimental stages. Private downloaded corpora live under
build/corpora and are excluded by the inverted .gitignore. No private contents
should be copied into public reports.

See the
[complete 2.51 GB corpus measurements](reports/full-corpus-2026-10-15.json) for
actual end-to-end indexing and repeated search latencies on both databases, and
[document/retrieval verification](reports/verification-2026-10-16.json) for
paired results, inspectable private evidence, PDF OCR routing, archive fixtures,
content-based MIME and metadata checks. The earlier
[performance measurements](reports/performance-2026-10-15.json) also cover
scaling fixtures. These are historical v0.1.0 measurements on the old schema,
not timings for v0.2.0. LanceDB was removed after that workload comparison.

Current checks cover Turso with deterministic embedding/extraction providers,
scoped priority/cancellation, transaction rollback, stale recovery and real
PDF/image/video/ASR and nested archive smoke tests.
[Latest verification](reports/structural-simplification-2026-10-16.json) also checks
unchanged public signatures, storage compatibility across the simplification,
exact retrieval/citation preservation, cache reuse and real multilingual E5
quality against the earlier fixture. It records 24 passing core contracts on
the current source; the public API, storage schema and provider defaults are
unchanged by this pass.
[Recorded v0.2.0 results](reports/runtime-2026-10-16.json) record 22 passing
core contracts, actual multilingual E5 quality diagnostics, live-query inference
timings and synthetic delta-indexing measurements. Run
`build.bat runtime-report` to publish matching current-source fixture results;
the publisher rejects mixed product hashes. That snapshot precedes the import
reorganization; [Indra results](reports/indra-2026-10-16.json) identify the
newer product and experimental source hashes. The full private corpus has not
been reindexed on this schema. Existing language experiments cover English,
Italian, French, German, Spanish, Russian, Chinese and Arabic OCR, and
EN/IT/RU/ZH/DE Whisper with automatic/correct/incorrect language settings.

## Remaining limitations

- Linux/macOS runtime verification and long/noisy audio quality evaluation.
- ANN indices and actual process/power-loss crash testing. Large scope-ID lists
  and broad scoped FTS matches still consume memory. Very large individual
  extractions/chunk batches can consume significant memory even though startup
  reads are paged.
- Visual embedding encoders are not implemented; image ingestion currently
  searches OCR text. Existing asset columns are not a visual-search API.
- Archive entries retain nested locator.entries chains, pages, order and
  metadata. Search scopes still select physical source files, not individual
  archive entries; embedded audio/video is not routed through the standalone
  custom ASR provider.
- .gitignore provider, following symlinks and alternate ASR adapters such as
  Sherpa.
- Embedding preset weights are resolved by the pinned Xberg release and cached
  per instance; independent model-weight fingerprints and controlled model
  upgrades need stronger handling before production use. Very long chunks are
  truncated by the configured embedding token window (512 by default).
- Xberg warnings and rich geometry need a richer normalized provenance contract.
  Do not infer per-word timestamp accuracy or universal language detection.
