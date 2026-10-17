// Cross-source compatibility check; the baseline is an explicit local input.
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as current from "../rag.js";

const structural = Deno.args[1] === "structural";
const label = structural ? "structural" : "simplification";
const baselinePath = path.resolve(
  Deno.args[0] ??
    (structural
      ? "build/simplification/pass-one.js"
      : "build/simplification/before.js"),
);
const baselineBytes = await Deno.readFile(baselinePath);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(
  digest(baselineBytes),
  structural
    ? "e000c84e037c9ed58937ebac83160c03eb22c483152da72473b2ae2295f47f30"
    : "7fe5158d98e3ed668de247c35e3d809d63605c58f0e0c48b3df9a2784e5fdb0b",
  "Supply the unmodified source from before this simplification",
);
const baseline = await import(pathToFileURL(baselinePath).href);
assert.deepEqual(Object.keys(current), Object.keys(baseline));
const publicMethods = (module) =>
  Object.getOwnPropertyNames(module.Rag.prototype)
    .filter((name) => name !== "constructor" && !name.startsWith("_"))
    .map((name) => [name, module.Rag.prototype[name].length]);
assert.deepEqual(publicMethods(current), publicMethods(baseline));

await Deno.mkdir("build/simplification", { recursive: true });
const rootDir = await Deno.makeTempDir({ dir: "build/simplification" });
await Deno.mkdir(path.join(rootDir, "docs/sub"), { recursive: true });
for (
  const [name, text] of Object.entries({
    "a.txt": "science biblioteca città",
    "sub/copy.txt": "science biblioteca città",
    "b.txt": "contract renewal",
  })
) await Deno.writeTextFile(path.join(rootDir, "docs", name), text);
let extractions = 0;
let embeddingInputs = 0;
const options = {
  rootDir,
  storageDir: ".index",
  ocr: false,
  transcribe: false,
  worker: { idleMs: 10 },
  cache: { extractionContext: "content" },
  hookVersion: { extract: "compat-text-v1", embedding: "compat-vectors-v1" },
  extract: async ({ input }) => {
    extractions++;
    const text = await Deno.readTextFile(input.path);
    return {
      mime: "text/plain",
      units: [1, 2].map((page) => ({
        text,
        language: "it",
        language_source: "detected",
        origin: "native",
        locator: { page },
      })),
    };
  },
  embedding: ({ texts }) => {
    embeddingInputs += texts.length;
    return {
      vectors: texts.map((text) => [
        0.01 + (text.match(/science/gi) ?? []).length,
        0.01 + (text.match(/contract/gi) ?? []).length,
        0.01 + (text.match(/garden/gi) ?? []).length,
      ]),
    };
  },
};

async function snapshot(rag) {
  const searches = [];
  for (const mode of ["fulltext", "vector", "hybrid"]) {
    for (const include of [undefined, ["docs/sub/**"]]) {
      const result = await rag.search("science", {
        refresh: "none",
        mode,
        scope: { include, languages: ["it"], origins: ["native"] },
      });
      searches.push(result.hits.map((hit) => ({
        ...hit,
        citations: [...hit.citations].sort((a, b) =>
          a.occurrenceId.localeCompare(b.occurrenceId)
        ),
      })));
    }
  }
  return {
    searches,
    counts: (await rag.status()).counts,
    metadata: await rag.listUserMeta({ query: "flowers" }),
  };
}

let rag;
let assertions = 0;
try {
  rag = await baseline.Rag.init(options);
  await rag.addFolder("docs");
  assert.equal((await rag.index()).updated, 3);
  assert.equal(extractions, 2);
  const docs = (await rag.listDocuments()).documents;
  const note = await rag.addUserMeta({
    value: "garden flowers",
    documentIds: docs.map((doc) => doc.id),
  });
  await rag.search("flowers", { mode: "fulltext", refresh: "wait" });
  const before = await snapshot(rag);
  await rag.close();

  // Current code must read old native rows and reuse existing derived artifacts.
  rag = await current.Rag.init(options);
  await rag.addFolder("docs");
  const oldCalls = { extractions, embeddingInputs };
  assert.equal((await rag.index()).unchanged, 3);
  assert.deepEqual({ extractions, embeddingInputs }, oldCalls);
  assert.deepEqual(await snapshot(rag), before);
  assertions++;
  await rag.updateUserMeta(note.id, { value: "garden blossoms" });
  const updated = await rag.search("blossoms", {
    refresh: "wait",
    mode: "fulltext",
  });
  assert.equal(updated.hits[0].citations.length, 3);
  assert.equal(extractions, oldCalls.extractions);
  const after = await snapshot(rag);
  await rag.close();

  // The previous source can also consume new chunk/link writes, without a migration.
  rag = await baseline.Rag.init(options);
  await rag.addFolder("docs");
  assert.equal((await rag.index()).unchanged, 3);
  assert.deepEqual(await snapshot(rag), after);
  assertions++;
} finally {
  await rag?.close();
}

const source = await Deno.readFile("rag.js");
const readEvidence = async (name) => {
  const result = JSON.parse(
    await Deno.readTextFile(`build/results/${name}.json`),
  );
  for (
    const row of Array.isArray(result) ? result : [result.metadata ?? result]
  ) {
    assert.equal(
      row.productSha256 ?? row.sourceSha256,
      digest(source),
      `Rerun ${name}`,
    );
  }
  return result;
};
const [core, native, archives, storage, quality, policy] = await Promise.all([
  readEvidence("core-contracts-v2"),
  readEvidence("rag-native-v2-default"),
  readEvidence("rag-archives-v2"),
  readEvidence(`benchmark-storage-${label}`),
  readEvidence(`benchmark-quality-${label}`),
  readEvidence("xberg-policy"),
]);
const tesseract = structural
  ? await readEvidence("rag-native-v2-tesseract")
  : [];
assert.ok(tesseract.every((row) => row.report.failed === 0));
assert.equal(core.failed, 0);
assert.equal(core.passed, structural ? 24 : 22);
assert.ok(native.every((row) => row.report.failed === 0));
assert.ok(archives.every((row) => row.persisted && row.entryLimitRejected));
let pairedStorage;
if (structural) {
  assert.ok(native[0].sharedProviderIsolation?.documentContextPreserved);
  const before = JSON.parse(
    await Deno.readTextFile(
      "build/results/benchmark-storage-structural-before.json",
    ),
  );
  assert.equal(before.metadata.productSha256, digest(baselineBytes));
  pairedStorage = storage.results.map((after) => {
    const previous = before.results.find((row) =>
      row.documents === after.documents
    );
    assert.equal(previous.dimensions, after.dimensions);
    assert.equal(previous.independentCosineQueries, 3);
    assert.equal(after.independentCosineQueries, 3);
    return {
      documents: after.documents,
      dimensions: after.dimensions,
      before: {
        indexMs: previous.indexMs,
        oneChangedMs: previous.oneChanged.ms,
        search: previous.search,
      },
      after: {
        indexMs: after.indexMs,
        oneChangedMs: after.oneChanged.ms,
        search: after.search,
      },
    };
  });
}
const recorded = JSON.parse(
  await Deno.readTextFile("reports/runtime-2026-10-16.json"),
);
const initial = structural
  ? JSON.parse(
    await Deno.readTextFile("reports/simplification-2026-10-16.json"),
  )
  : null;
for (const row of quality.results.filter((row) => row.mode)) {
  const previous = recorded.retrieval.rows.find((item) =>
    item.mode === row.mode
  );
  assert.deepEqual(row.metrics, previous.metrics);
  assert.deepEqual(row.byLanguage, previous.byLanguage);
}
const report = {
  productVersion: current.VERSION,
  measuredAt: new Date().toISOString(),
  runtime: Deno.version,
  platform: Deno.build,
  size: {
    unit: "UTF-8 source bytes",
    before: baselineBytes.length,
    after: source.length,
    saved: baselineBytes.length - source.length,
    reductionPercent: 100 * (1 - source.length / baselineBytes.length),
    targetBytes: 20000,
    targetReached: source.length <= 20000,
  },
  baselineSha256: digest(baselineBytes),
  productSha256: digest(source),
  originalSource: initial
    ? {
      sha256: initial.baselineSha256,
      bytes: initial.size.before,
      totalSavedBytes: initial.size.before - source.length,
      totalReductionPercent: 100 * (1 - source.length / initial.size.before),
    }
    : undefined,
  compatibility: {
    matchingExportsAndPublicSignatures: true,
    nativeStoreRoundTrips: assertions,
    exactHitScoresIdsAndCitationsPreserved: true,
    unchangedExtractionAndEmbeddingReuse: true,
    sharedMetadataUpdatedWithoutReextraction: true,
  },
  changes: structural
    ? [
      "One per-instance provider replaces separate ingestion, query and direct-provider objects; mutable native resources remain local to calls.",
      "Native EventTarget and events.once replace the custom waiter subscription, abort and listener-cleanup protocol.",
      "Explicit async disposable operation lifetimes replace public-method callback wrappers and track queued work through failures and close.",
      "FTS and metadata share native IN-subquery scope filtering and one JavaScript score order; no separate global FTS/JavaScript visibility pass or eligible-chunk Set remains.",
      "Ranking happens once, before fetching only final-hit text and citations.",
      "Watch events use the same hash reconciliation as search/index rather than updating stale and queues independently.",
      "Source globs are compiled at registration; configuration is copied once and validated once.",
      "One Xberg input/result boundary serves OCR, extraction and embeddings; Paddle/Tesseract configuration is shared.",
      "Counts use one native query; GC uses the native mutation count.",
    ]
    : [
      "One runtime state record per document replaces four independent maps for revisions, priority, retries and outcomes.",
      "One file-revision check surrounds extraction and publication.",
      "Storage owns shared transaction boundaries and batched row insertion; no schema or public API change.",
      "Native resource disposal replaces nested cleanup blocks in media processing.",
      "Hook dispatch is shared with explicit built-in functions; public lifecycle checks and throws remain explicit.",
      "The embedding descriptor is computed per provider, rather than rebuilt and hashed for every chunk.",
    ],
  dependencies: { turso: "0.8.3", xberg: "1.3.10", nodeAv: "6.1.1" },
  checks: {
    core: { passed: core.passed, failed: core.failed },
    native: [...native, ...tesseract].map((row) => ({
      provider: row.ocrProvider,
      searchableChannels: row.searchableChannels,
      durationLimit: row.durationLimit,
      elementaryVideo: row.elementaryVideo,
      sharedProviderIsolation: row.sharedProviderIsolation,
    })),
    archives: archives.map((row) => ({
      nestedEntryProvenance: row.nestedEntryProvenance,
      persisted: row.persisted,
      entryLimitRejected: row.entryLimitRejected,
    })),
    pdfOcrRouting: policy.rows.map((row) => ({
      fixture: row.name,
      ocrCalls: row.ocrCalls,
    })),
    storage: storage.results.map((row) => ({
      documents: row.documents,
      indexMs: row.indexMs,
      unchangedMs: row.unchangedMs,
      oneChanged: {
        ms: row.oneChanged.ms,
        extractionCalls: row.oneChanged.extractionCalls,
        embeddingInputs: row.oneChanged.embeddingInputs,
      },
      independentCosineQueries: row.independentCosineQueries,
      search: row.search,
    })),
    pairedStorage,
    multilingualQuality: {
      documents: quality.metadata.embedding.documents,
      queries: quality.metadata.embedding.queries,
      earlierMetricsSourceSha256: recorded.productSha256,
      metricsAndLanguageBreakdownsMatchEarlierFixture: true,
      rows: quality.results.filter((row) => row.mode).map((row) => ({
        mode: row.mode,
        metrics: row.metrics,
        byLanguage: row.byLanguage,
      })),
    },
  },
  limits: [
    "Windows x64 execution only; no new Linux or macOS execution evidence.",
    "This pass preserves existing features and existing documented limitations; it does not implement previously deferred features.",
    "The private 2.51 GB corpus and optional experimental providers were not rebenchmarked.",
    "The 20 KB source target is not reached. This is a modest simplification pass, not evidence that the remaining design is irreducible.",
    structural
      ? "The paired storage experiment uses one 1000-document public synthetic workload and 12 searches per mode in fresh processes. It is a regression check, not a general performance guarantee."
      : "Storage timings are verification measurements, not a paired performance comparison with the previous source.",
  ],
};
await Deno.writeTextFile(
  `reports/${
    structural ? "structural-simplification" : "simplification"
  }-2026-10-16.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify({
  productSha256: report.productSha256,
  size: report.size,
  core: report.checks.core,
  compatibility: report.compatibility,
  pairedStorage,
}));
