// Probe only the public FastEmbed executionProviders option; no DLL overrides,
// private session access, dependency patches or ONNX graph modifications.
import * as path from "node:path";
import { createHash } from "node:crypto";
import { EmbeddingModel, FlagEmbedding, Pooling } from "npm:fastembed@3.0.0";
import * as ort from "npm:onnxruntime-node@1.21.0";
import { FASTEMBED } from "./fastembed.js";
import { Rag } from "../rag.js";
import { embeddingHoldout, embeddingTopics } from "./embedding-fixtures.js";

const root = path.resolve("build/fastembed-test");
const directory = path.join(
  root,
  "model-owner/models/embeddings/models--xberg-io--embedding-models/snapshots",
  FASTEMBED.baseRevision,
  "multilingual-e5-base",
);
const report = {
  platform: Deno.build,
  runtime: Deno.version,
  requested: "dml",
  available: ort.listSupportedBackends(),
  success: false,
};
const docs = [...embeddingTopics, ...embeddingHoldout].flatMap((
  [topic, en, it],
) => [{ topic, text: en }, { topic, text: it }]);
const queries = [
  ...embeddingTopics.flatMap(([topic, , , it, en, other], i) => [
    { topic, text: it, language: "it" },
    { topic, text: en, language: "en" },
    { topic, text: other, language: i % 2 ? "zh" : "ru" },
  ]),
  ...embeddingHoldout.flatMap(([topic, , , items]) =>
    Object.entries(items).map(([language, text]) => ({ topic, language, text }))
  ),
];
function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return dot / Math.sqrt(aa * bb);
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
const timer = setTimeout(() => {
  report.error =
    "Public provider initialization/inference exceeded 180 seconds";
  Deno.writeTextFileSync(
    path.join(root, "gpu.json"),
    JSON.stringify(report, null, 2),
  );
  Deno.exit(1);
}, 180000);
try {
  const started = performance.now();
  const engine = await FlagEmbedding.init({
    model: EmbeddingModel.CUSTOM,
    modelAbsoluteDirPath: directory,
    modelName: "model.onnx",
    pooling: Pooling.Mean,
    maxLength: 512,
    executionProviders: ["dml"],
    showDownloadProgress: false,
  });
  report.setupMs = performance.now() - started;
  const embed = async (texts, role = "document", batch = 8) => {
    const vectors = [];
    for await (
      const part of engine.embed(
        texts.map((text) =>
          `${role === "query" ? "query" : "passage"}: ${text}`
        ),
        batch,
      )
    ) vectors.push(...part);
    return { vectors };
  };
  report.rows = [];
  for (let i = 0; i < 4; i++) {
    const began = performance.now();
    const vector = await engine.queryEmbed(
      "Quanto preavviso serve per lasciare un appartamento in affitto?",
    );
    report.rows.push({
      ms: performance.now() - began,
      dimensions: vector.length,
      finite: vector.every(Number.isFinite),
      norm: Math.hypot(...vector),
    });
  }
  report.batches = [];
  for (
    const [workload, texts] of Object.entries({
      short: docs.slice(0, 16).map((doc) => doc.text),
      long: docs.slice(0, 8).map((doc) => (doc.text + " ").repeat(18)),
    })
  ) {
    // Warm native compilation for both tensor shapes before timing them.
    await embed(texts, "document", 8);
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const batch of repeat % 2 ? [8, 1] : [1, 8]) {
        const start = performance.now();
        await embed(texts, "document", batch);
        const ms = performance.now() - start;
        report.batches.push({
          workload,
          batch,
          repeat,
          texts: texts.length,
          ms,
          textsPerSecond: texts.length / ms * 1000,
        });
      }
    }
  }
  const cpu = JSON.parse(
    await Deno.readTextFile(path.join(root, "xberg-vectors.json")),
  );
  const vectors = (await embed(
    queries.map((query) => query.text),
    "query",
    1,
  )).vectors;
  report.minQueryCosineVsCpu = Math.min(
    ...vectors.map((vector, i) => cosine(vector, cpu.queryVectors[i])),
  );
  const storage = await Deno.makeTempDir({ dir: root, prefix: "gpu-index-" });
  const rag = await Rag.init({
    rootDir: path.join(root, "input"),
    storageDir: storage,
    ocr: false,
    transcribe: false,
    embedding: ({ texts, role, signal }) => {
      signal?.throwIfAborted();
      return embed(texts, role);
    },
    hookVersion: { embedding: "fastembed-3-e5-base-dml-512" },
    chunking: { maxCharacters: 1200, overlap: 0 },
  });
  try {
    await rag.addFolder(".");
    const indexStart = performance.now();
    const indexReport = await rag.index();
    report.indexed = {
      ms: performance.now() - indexStart,
      report: indexReport,
    };
    if (indexReport.failed) throw new Error(JSON.stringify(indexReport.errors));
    report.retrieval = [];
    for (const mode of ["vector", "hybrid"]) {
      const rows = [];
      for (const query of queries) {
        const started = performance.now();
        const result = await rag.search(query.text, {
          mode,
          refresh: "none",
          limit: 5,
        });
        const relevant = result.hits.map((hit) =>
          hit.citations.some((citation) =>
            path.basename(citation.path).startsWith(query.topic + "-")
          )
        );
        rows.push({
          topic: query.topic,
          language: query.language,
          ms: performance.now() - started,
          hit1: Number(relevant[0] ?? false),
          hit5: Number(relevant.includes(true)),
        });
      }
      report.retrieval.push({
        mode,
        hit1: rows.reduce((sum, row) => sum + row.hit1, 0) / rows.length,
        hit5: rows.reduce((sum, row) => sum + row.hit5, 0) / rows.length,
        latency: stats(rows.map((row) => row.ms)),
        rows,
      });
    }
  } finally {
    await rag.close();
  }
  report.success = true;
} catch (error) {
  report.error = String(error).replaceAll(path.resolve("."), "<workspace>");
} finally {
  clearTimeout(timer);
}
report.scriptSha256 = createHash("sha256").update(
  await Deno.readFile(import.meta.filename),
).digest("hex");
await Deno.writeTextFile(
  path.join(root, "gpu.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({
  success: report.success,
  error: report.error,
  setupMs: report.setupMs,
  indexMs: report.indexed?.ms,
  minQueryCosineVsCpu: report.minQueryCosineVsCpu,
  retrieval: report.retrieval?.map(({ rows: _rows, ...row }) => row),
}));
