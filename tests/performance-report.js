// Publish aggregate results only. Never spread a private corpus result object.

const read = async (filename) =>
  JSON.parse(await Deno.readTextFile(`build/results/${filename}.json`));
const baseline = await read("benchmark-storage-baseline");
const storage = await read("benchmark-storage-validated");
const scale = await read("benchmark-storage-scale");
if (scale.metadata.productSha256 !== storage.metadata.productSha256) {
  throw new Error(
    "Scale and main benchmarks must exercise the same product source",
  );
}
storage.results.push(...scale.results);
const quality = await read("benchmark-quality-validated");
const primitives = await read("benchmark-primitives-validated");
const asr = await read("benchmark-asr-threads");
const native = await read("rag-native");
const privateResults = await read("rag-corpus");
const verifiedDownload = JSON.parse(
  await Deno.readTextFile("build/corpora/verification.json"),
);
if (verifiedDownload.failures.length || verifiedDownload.partialFiles) {
  throw new Error(
    "Finish verifying corpus downloads before publishing the report",
  );
}
const download = {
  expected: verifiedDownload.expected,
  verified: verifiedDownload.verified,
  bytes: verifiedDownload.bytes,
  nativePdfExports: verifiedDownload.nativePdfExports,
};
const corpus = privateResults.map((row) => ({
  driver: row.driver,
  selectedFiles: row.selectedFiles,
  indexMs: row.indexMs,
  unchangedMs: row.unchangedMs,
  states: row.states,
  counts: row.counts,
  search: row.search,
  lexicalHits: row.lexicalHits,
  vectorHits: row.vectorHits,
  failures: row.index.failed,
  skipped: row.index.skipped,
}));
const vectorWinnerAgreesAcrossDrivers = privateResults.every((row) =>
  row.topVectorChunk === privateResults[0].topVectorChunk
);
const report = {
  metadata: {
    ...storage.metadata,
    packages: {
      xberg: "1.3.10",
      turso: "0.8.3",
      lancedb: "0.40.0",
      nodeAv: "6.1.1",
    },
    contractTestsPassed: 7,
    note:
      "All final benchmark suites ran sequentially. Network corpus downloads may overlap. Baseline was recorded before optimization with 12 samples per mode/scope; final storage has 40. Current source reproduces final behavior; no VCS baseline checkout is available.",
  },
  baseline: {
    metadata: {
      ...baseline.metadata,
      cpu: baseline.metadata.cpu.replaceAll("\u0000", "").trim(),
    },
    results: baseline.results,
  },
  scaleMetadata: scale.metadata,
  storage: storage.results,
  quality,
  primitives: primitives.results,
  asr,
  native,
  corpus: { results: corpus, vectorWinnerAgreesAcrossDrivers, download },
};
// CPU strings on Windows can contain trailing NULs in os.cpus().
report.metadata.cpu = report.metadata.cpu.replaceAll("\u0000", "").trim();
await Deno.writeTextFile(
  "reports/performance-2026-10-15.json",
  JSON.stringify(report, null, 2),
);
console.log("Published sanitized performance JSON measurements.");
