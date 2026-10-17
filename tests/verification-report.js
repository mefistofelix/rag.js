// Whitelist aggregate data: never copy private query/result objects to reports/.
import * as path from "node:path";
import assert from "node:assert/strict";

const token = Deno.args[0] ?? "pf";
assert.match(token, /^[a-z0-9-]+$/);
const read = async (filename) => JSON.parse(await Deno.readTextFile(filename));
const directory = path.resolve("build/full-corpus", token);
const audits = await Promise.all(
  ["turso", "lancedb"].map((driver) =>
    read(path.join(directory, `${driver}-audit.json`))
  ),
);
assert.equal(audits[0].sourceSha256, audits[1].sourceSha256);
const review = await read("build/full-corpus/pooled-judgments.json");
const documents = await read("build/xc/results.json");
const policy = await read("build/results/xberg-policy.json");
const oracles = await Promise.all(
  ["turso", "lancedb"].map((driver) =>
    read(path.join(directory, `${driver}-vector-oracle.json`))
  ),
);
const batch = await read("build/results/benchmark-xberg-batch.json");
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sequentialMs = median(
  batch.rows.filter((row) => row.mode === "sequential").map((row) => row.ms),
);
const batchMs = median(
  batch.rows.filter((row) => row.mode === "batch").map((row) => row.ms),
);
assert.equal(documents.sourceSha256, policy.sourceSha256);
assert.equal(documents.rows.length, 65);
const reviewed = (audit) =>
  ["natural-pdf", "transcript-audio"].flatMap((kind) =>
    ["fulltext", "vector", "hybrid"].map((mode) => {
      const rows = audit.rows.filter((row) =>
        row.scope === "all" && row.kind === kind && row.mode === mode
      );
      const ranks = rows.map((row) =>
        row.hits.findIndex((hit) =>
          hit.citations.some((citation) =>
            row.relevantDocumentIds.includes(citation.documentId)
          ) ||
          review.judgments.some((judgment) =>
            judgment.relevant && judgment.queryId === row.id &&
            judgment.chunkId === hit.chunkId
          )
        )
      );
      return {
        kind,
        mode,
        queries: rows.length,
        hit1: ranks.filter((rank) => rank === 0).length / ranks.length,
        hit5: ranks.filter((rank) => rank >= 0).length / ranks.length,
        mrr5: ranks.reduce((sum, rank) =>
          sum + (rank >= 0 ? 1 / (rank + 1) : 0), 0) / ranks.length,
      };
    })
  );
const agreement = ["fulltext", "vector", "hybrid"].map((mode) => {
  let orderedEqual = 0, overlap = 0, maxScoreDifference = 0;
  const rows = audits[0].rows.filter((row) =>
    row.mode === mode && row.scope === "all"
  );
  for (const row of rows) {
    const other = audits[1].rows.find((item) =>
      item.id === row.id && item.mode === mode && item.scope === "all"
    );
    const a = row.hits.map((hit) => hit.chunkId),
      b = other.hits.map((hit) => hit.chunkId);
    if (JSON.stringify(a) === JSON.stringify(b)) orderedEqual++;
    overlap += a.filter((id) => b.includes(id)).length /
      Math.max(1, a.length, b.length);
    for (const hit of row.hits) {
      const matching = other.hits.find((item) => item.chunkId === hit.chunkId);
      if (matching) {
        maxScoreDifference = Math.max(
          maxScoreDifference,
          Math.abs(hit.score - matching.score),
        );
      }
    }
  }
  return {
    mode,
    queries: rows.length,
    orderedEqual,
    meanTop5Overlap: overlap / rows.length,
    maxScoreDifference,
  };
});
const byType = [];
const available = documents.rows.filter((row) => !row.unavailable);
for (const type of [...new Set(available.map((row) => row.type))].sort()) {
  const rows = available.filter((row) => row.type === type);
  const scored = rows.filter((row) => row.tokenF1 !== undefined);
  const times = rows.map((row) => row.ms).sort((a, b) => a - b);
  byType.push({
    type,
    files: rows.length,
    errors: rows.filter((row) => row.error).length,
    totalMs: times.reduce((sum, n) => sum + n, 0),
    medianMs: times[Math.floor(times.length / 2)],
    ocrCalls: rows.reduce((sum, row) => sum + row.ocrCalls, 0),
    scored: scored.length,
    meanTokenF1: scored.length
      ? scored.reduce((sum, row) => sum + row.tokenF1, 0) / scored.length
      : undefined,
  });
}
const raw = {
  date: "2026-10-16",
  target: documents.target,
  deno: documents.deno,
  xberg: documents.xberg,
  indexedSourceSha256: audits[0].sourceSha256,
  documentTestSourceSha256: documents.sourceSha256,
  retrieval: {
    distinctPdfQuestions: 12,
    audioQueryVariants: 6,
    audioTopics: 3,
    referenceDocuments: audits[0].referenceEvidence.length,
    checkedQueryScopeModeCalls: audits.map((audit) => ({
      driver: audit.driver,
      calls: audit.rows.length,
      emptyScopeChecks: 18 * 3,
    })),
    agreement,
    vectorOracle: oracles,
    originalJudgments: audits.map((audit) => ({
      driver: audit.driver,
      metrics: audit.metrics.map(({ medianMs: _median, ...metric }) => metric),
    })),
    limitedPooledReview: {
      addedPositiveChunks: review.judgments.length,
      questionsReviewed:
        new Set(review.judgments.map((judgment) => judgment.queryId)).size,
      drivers: audits.map((audit) => ({
        driver: audit.driver,
        metrics: reviewed(audit),
      })),
    },
  },
  documents: {
    descriptorRevision: documents.xbergRevision,
    availableCorpusRevision: documents.corpusRevision,
    websiteSelected: documents.websiteCount,
    websiteAvailable: available.filter((row) => row.website).length,
    unavailableWebsiteDescriptors: documents.rows.filter((row) =>
      row.unavailable
    ).map((row) => row.descriptor),
    downloadedBytes: available.reduce((sum, row) => sum + row.bytes, 0),
    descriptorSizeMismatches:
      available.filter((row) => row.bytes !== row.descriptorBytes).length,
    extractionMs: available.reduce((sum, row) => sum + row.ms, 0),
    modelSeedMs: documents.setupMs,
    configuration: documents.configuration,
    byType,
    archives: available.filter((row) => !row.website).map((row) => ({
      type: row.type,
      mime: row.mime,
      entries: row.archiveEntries,
      units: row.units,
      ms: row.ms,
      tokenF1: row.tokenF1,
    })),
  },
  policy: {
    pdf: policy.rows.map(({ name, ocrCalls, pages }) => ({
      fixture: name,
      ocrCalls,
      pages,
    })),
    renamed: policy.renamed,
    imageMetadataKeys: Object.keys(policy.builtinImageMetadata),
  },
  embeddingBatch: {
    texts: batch.texts,
    repeats: 3,
    sequentialMedianMs: sequentialMs,
    batchMedianMs: batchMs,
    speedup: sequentialMs / batchMs,
    maxVectorDifference: Math.max(
      ...batch.rows.map((row) => row.maxDifference),
    ),
  },
};
await Deno.writeTextFile(
  "reports/verification-2026-10-16.json",
  JSON.stringify(raw, null, 2),
);
console.log("Published aggregate verification JSON without private contents.");
