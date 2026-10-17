// Publish only public-fixture aggregates; no source paths, texts or transcripts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { VERSION } from "../rag.js";

const read = async (name) =>
  JSON.parse(await Deno.readTextFile(`build/results/${name}.json`));
const productSha256 = createHash("sha256").update(await Deno.readFile("rag.js"))
  .digest("hex");
const [core, native, archives, storage, quality] = await Promise.all([
  read("core-contracts-v2"),
  read("rag-native-v2-default"),
  read("rag-archives-v2"),
  read("benchmark-storage-native-records-release"),
  read("benchmark-quality-native-records-release"),
]);
for (
  const item of [
    core,
    ...native,
    ...archives,
    storage.metadata,
    quality.metadata,
  ]
) {
  assert.equal(
    item.productSha256,
    productSha256,
    "Rerun the current-source checks before publishing",
  );
}
assert.equal(core.failed, 0);
assert.ok(core.passed > 0);
assert.ok(native.every((row) => row.report.failed === 0));
assert.ok(
  archives.every((row) =>
    row.nestedEntryProvenance && row.persisted && row.entryLimitRejected
  ),
);

const storageRows = (input) =>
  input.results.map((row) => ({
    driver: row.driver,
    documents: row.documents,
    dimensions: row.dimensions,
    indexMs: row.indexMs,
    unchangedMs: row.unchangedMs,
    reopenMs: row.reopenMs,
    oneChanged: {
      ms: row.oneChanged.ms,
      extractionCalls: row.oneChanged.extractionCalls,
      embeddingInputs: row.oneChanged.embeddingInputs,
    },
    search: row.search,
    independentCosineQueries: row.independentCosineQueries,
  }));
let earlierScale;
try {
  const scale = await read("benchmark-storage-native-records-final");
  earlierScale = {
    productSha256: scale.metadata.productSha256,
    matchesCurrentSource: scale.metadata.productSha256 === productSha256,
    note:
      "Earlier development snapshot of the six-table Turso design. Separate source identity; not final-source validation.",
    conditions: scale.metadata.conditions,
    results: storageRows(scale).filter((row) => row.documents === 10000),
  };
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

const result = {
  version: VERSION,
  measuredAt: new Date().toISOString(),
  productSha256,
  runtime: core.runtime,
  platform: core.platform,
  dependencies: { turso: "0.8.3", xberg: "1.3.10", nodeAv: "6.1.1" },
  core: { passed: core.passed, failed: core.failed },
  native: native.map((row) => ({
    driver: row.driver,
    timings: row.timings,
    report: row.report,
    searchableChannels: row.searchableChannels,
    transcriptionSegments: row.transcriptionSegments,
    ocrProvider: row.ocrProvider,
    elementaryVideo: row.elementaryVideo,
    durationLimit: row.durationLimit,
  })),
  archives: archives.map((row) => ({
    nestedEntryProvenance: row.nestedEntryProvenance,
    duplicateOccurrences: row.duplicateOccurrences,
    uniqueChunks: row.uniqueChunks,
    persisted: row.persisted,
    entryLimitRejected: row.entryLimitRejected,
  })),
  storage: {
    conditions: storage.metadata.conditions,
    results: storageRows(storage),
    note:
      "Deterministic 768-dimensional vectors isolate storage; model/OCR/ASR costs are excluded. Search refresh=none.",
  },
  retrieval: {
    documents: 16,
    questions: 24,
    languages: ["it", "en", "ru", "zh"],
    rows: quality.results.filter((row) => row.mode).map((row) => ({
      mode: row.mode,
      metrics: row.metrics,
      cachedQueryLatency: row.latency,
      byLanguage: row.byLanguage,
    })),
    liveQueryLatency: quality.results.find((row) => row.endToEnd)?.endToEnd,
    note:
      "Small manually labeled public topic fixture, not a general leaderboard. Cached-query and live-inference timings are distinct.",
  },
  earlierScale,
  limits: [
    "Windows x64 runtime tested; Linux/macOS runtime unverified.",
    "Transaction rollback tested; abrupt power-loss durability not certified.",
    "The complete private 2.51 GB corpus was not reindexed on v0.2.0.",
    "Image-vector encoders are not implemented; image search uses OCR text.",
  ],
};
await Deno.writeTextFile(
  "reports/runtime-2026-10-16.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    published: "reports/runtime-2026-10-16.json",
    passed: core.passed,
    productSha256,
  }),
);
