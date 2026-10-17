// Publish aggregate measurements from public fixtures; never private vectors.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = async (filename) =>
  createHash("sha256").update(await Deno.readFile(filename)).digest("hex");
const read = async (filename) =>
  JSON.parse(await Deno.readTextFile("build/fastembed-test/" + filename));
const measured = await read("results.json");
assert.equal(measured.productSha256, await hash("rag.js"));
for (const [filename, digest] of Object.entries(measured.experimentSha256)) {
  assert.equal(await hash(filename), digest);
}
assert.equal(measured.documents, 28);
assert.equal(measured.queries, 54);
assert.ok(measured.parity.every((row) => row.minCosine > 0.99999));
const cpu = measured.results.find((row) => row.profile === "xberg");
const fast = measured.results.find((row) => row.profile === "same-model");
assert.equal(cpu.indexed.report.embeddingsGenerated, 28);
assert.equal(fast.indexed.report.embeddingsGenerated, 28);
assert.equal(
  cpu.retrieval.find((row) => row.mode === "vector").metrics.hit1,
  fast.retrieval.find((row) => row.mode === "vector").metrics.hit1,
);
const gpu = await read("gpu.json");
assert.equal(gpu.scriptSha256, await hash("tests/fastembed-gpu.js"));
assert.equal(gpu.success, true);
assert.ok(gpu.minQueryCosineVsCpu > 0.99999);
assert.equal(gpu.indexed.report.failed, 0);
const long = await read("long-results.json");
assert.equal(long.sourceSha256, await hash("tests/fastembed-long.js"));
assert.equal(
  long.results[0].report.embeddingsGenerated,
  long.results[1].report.embeddingsGenerated,
);
assert.ok(long.boundary.minCrossProviderCosine > 0.99999);
// Preserve the tested preset's actual file fingerprints, including tokenizer.
const preset = {};
for (
  const name of [
    "model_optimized.onnx",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
  ]
) {
  const filename =
    "build/fastembed-test/default-cache/models/fastembed/Qdrant_bge-small-en-v1.5-onnx-Q/" +
    name;
  preset[name] = {
    sha256: await hash(filename),
    bytes: (await Deno.stat(filename)).size,
  };
}
const report = {
  ...measured,
  notes: [
    ...measured.notes.map((note) =>
      note.replace(
        "no GPU test here",
        "GPU measurements are attached separately",
      )
    ),
    "GPU warm tensor shapes were prepared before batch timings. ORT warns that some nodes remain on CPU; no all-GPU placement claim.",
    "Setup-through-first-inference includes baseline model-cache copying and is not a fair cold-download/startup comparison.",
    "Long-file ingestion uses default1200-character chunks, producing32 vectors on16 files for both engines;512-token boundary probes have equivalent truncation.",
  ],
  results: measured.results.map(({ indexed, retrieval, ...row }) => ({
    ...row,
    indexed: {
      ms: indexed.ms,
      report: indexed.report,
      calls: indexed.calls.length,
      embeddedTexts: indexed.calls.reduce((sum, call) => sum + call.texts, 0),
    },
    retrieval: retrieval.map(({ rows: _rows, ...result }) => result),
  })),
  defaultPresetFiles: preset,
  gpu: {
    ...gpu,
    retrieval: gpu.retrieval.map(({ rows: _rows, ...row }) => row),
  },
  longIngestion: long,
  decision: {
    default: "Xberg multilingual-e5-base",
    reason:
      "Same-model FastEmbed CPU is slower on short queries/ingestion. Its English default loses multilingual relevance. DirectML helps long-file ingestion but is slower on short requests.",
    gpuOpportunity:
      "Public DirectML path shows a useful full-ingestion gain on the long-text fixture. Keep experimental until supported-target native tokenizers and public resource disposal are addressed.",
    limits:
      "No private-corpus reindex, GPU node-placement profile or non-Windows execution. No claim that the smaller English preset and FP32 multilingual E5 are equivalent models.",
  },
};
await Deno.writeTextFile(
  "reports/fastembed-2026-10-16.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    published: "reports/fastembed-2026-10-16.json",
    decision: report.decision,
  }),
);
