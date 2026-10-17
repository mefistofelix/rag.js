// Test the existing public Rust/ONNX path before considering another provider.
// Run sequentially while no full-corpus/native benchmark worker is active.
import assert from "node:assert/strict";
import * as path from "node:path";
import * as xberg from "npm:@xberg-io/xberg@1.3.10";

const modelDirectory = path.resolve(
  Deno.args[0] ?? "build/oa/e/models/embeddings",
);
const topics = [
  "astronomy telescope stars",
  "coral reefs oceanography",
  "library books history",
  "railway tickets timetable",
  "contract payments invoices",
  "agricultural land crops",
  "botanical garden plants",
  "software source code",
];
const texts = Array.from(
  { length: 16 },
  (_, i) =>
    `passage: Document ${i}. ${(`${topics[i % topics.length]}. `).repeat(35)}`,
);
const inputs = texts.map((text) => ({
  kind: "bytes",
  bytes: new TextEncoder().encode(text),
  mimeType: "text/plain",
  filename: "embedding.txt",
}));
const config = {
  disableOcr: true,
  useCache: false,
  chunking: {
    maxCharacters: Math.max(...texts.map((text) => Array.from(text).length)) +
      1,
    overlap: 0,
    embedding: {
      model: { type: "preset", name: "multilingual" },
      normalize: true,
      cacheDir: modelDirectory,
      acceleration: { provider: "cpu" },
      maxSequenceLength: 512,
    },
  },
};
function vectors(result) {
  assert.equal(result.errors.length, 0);
  return result.results.map((document) => {
    assert.equal(document.chunks.length, 1);
    assert.equal(document.chunks[0].embedding.length, 768);
    return document.chunks[0].embedding;
  });
}
const coldStart = performance.now();
vectors(await xberg.extract(inputs[0], config));
const coldMs = performance.now() - coldStart;
const rows = [];
let reference;
// Alternate order to reduce an ordering/thermal bias.
for (let repeat = 0; repeat < 3; repeat++) {
  for (
    const mode of repeat % 2 ? ["batch", "sequential"] : ["sequential", "batch"]
  ) {
    const start = performance.now();
    let output;
    if (mode === "batch") {
      output = vectors(await xberg.extractBatch(inputs, config));
    } else {
      output = [];
      for (const input of inputs) {
        output.push(...vectors(await xberg.extract(input, config)));
      }
    }
    const ms = performance.now() - start;
    assert.equal(output.length, texts.length);
    reference ??= output;
    let maxDifference = 0;
    for (let i = 0; i < output.length; i++) {
      for (let j = 0; j < 768; j++) {
        maxDifference = Math.max(
          maxDifference,
          Math.abs(output[i][j] - reference[i][j]),
        );
      }
    }
    assert.ok(
      maxDifference < 1e-4,
      "Batch results must preserve vector meaning and input order within floating-point tolerance",
    );
    rows.push({ mode, repeat, ms, maxDifference });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
const result = {
  deno: Deno.version,
  target: Deno.build,
  xberg: "1.3.10",
  provider: "cpu",
  texts: texts.length,
  textCharacters: texts.map((text) => text.length),
  coldMs,
  rows,
};
await Deno.mkdir("build/results", { recursive: true });
await Deno.writeTextFile(
  "build/results/benchmark-xberg-batch.json",
  JSON.stringify(result, null, 2),
);
