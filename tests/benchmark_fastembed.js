// Same-weight runtime comparison plus the stock English FastEmbed preset.
import assert from "node:assert/strict";
import * as path from "node:path";
import { cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import { Rag } from "../rag.js";
import { createFastEmbed, FASTEMBED, prepareBge } from "./fastembed.js";
import { embeddingHoldout, embeddingTopics } from "./embedding-fixtures.js";

const root = path.resolve("build/fastembed-test");
const baseline = path.join(root, "model-owner");
const cache = path.join(baseline, "models/embeddings");
const baseModel = path.join(
  cache,
  "models--xberg-io--embedding-models/snapshots",
  FASTEMBED.baseRevision,
  "multilingual-e5-base",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const docs = [...embeddingTopics, ...embeddingHoldout].flatMap((
  [topic, en, it],
) => [
  { id: topic + "-en", topic, text: en },
  { id: topic + "-it", topic, text: it },
]);
const queries = [
  ...embeddingTopics.flatMap(([topic, , , it, en, other], i) => [
    { topic, text: it, language: "it", set: "baseline" },
    { topic, text: en, language: "en", set: "baseline" },
    { topic, text: other, language: i % 2 ? "zh" : "ru", set: "baseline" },
  ]),
  ...embeddingHoldout.flatMap(([topic, , , items]) =>
    Object.entries(items).map(([language, text]) => ({
      topic,
      text,
      language,
      set: "holdout",
    }))
  ),
];
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return dot / Math.sqrt(aa * bb);
}
async function runChild(args) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--node-modules-dir=auto",
      "-A",
      import.meta.filename,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const log = new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
  await Deno.writeTextFile(
    path.join(root, args[0] + "-" + (args[1] ?? "models") + ".log"),
    log,
  );
  assert.ok(result.success, log);
  return log;
}
if (Deno.args[0] === "prepare") {
  const owner = await Rag.init({
    storageDir: baseline,
    ocr: false,
    transcribe: false,
  });
  try {
    await owner.embed(["Multilingual embedding warmup"], { role: "query" });
  } finally {
    await owner.close();
  }
  await prepareBge(path.join(root, "default-cache"));
} else if (Deno.args[0] === "worker") {
  const profile = Deno.args[1], store = Deno.args[2];
  await Deno.mkdir(store, { recursive: true });
  let peakRss = 0;
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, Deno.memoryUsage().rss);
  }, 200);
  const setup = performance.now();
  let owner, fast;
  const embeddingCalls = [];
  if (profile === "xberg") {
    await Deno.mkdir(path.join(store, "models"), { recursive: true });
    await cp(cache, path.join(store, "models/embeddings"), { recursive: true });
    owner = await Rag.init({
      storageDir: store,
      ocr: false,
      transcribe: false,
      embedding: {
        model: "multilingual",
        acceleration: { provider: "cpu" },
        maxSequenceLength: 512,
      },
    });
  } else {
    if (profile === "default") {
      await cp(
        path.join(root, "default-cache/models"),
        path.join(store, "models"),
        { recursive: true },
      );
    }
    fast = await createFastEmbed({
      storageDir: store,
      modelDirectory: baseModel,
      profile,
      maxLength: 512,
      batchSize: 8,
    });
  }
  const embed = async (texts, options = {}) => {
    const started = performance.now();
    const response = owner
      ? await owner.embed(texts, options)
      : await fast.embed(texts, options);
    embeddingCalls.push({
      role: options.role ?? "document",
      texts: texts.length,
      ms: performance.now() - started,
    });
    assert.equal(response.vectors.length, texts.length);
    for (const vector of response.vectors) {
      assert.equal(vector.length, profile === "default" ? 384 : 768);
      assert.ok(vector.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-5);
    }
    return response;
  };
  let indexed;
  try {
    const first = performance.now();
    await embed([queries[0].text], { role: "query" });
    const firstInferenceMs = performance.now() - first;
    const setupThroughFirstInferenceMs = performance.now() - setup;
    const workload = {
      short: docs.slice(0, 16).map((doc) => doc.text),
      long: docs.slice(0, 8).map((doc) => (doc.text + " ").repeat(18)),
    };
    const batches = [];
    for (const [name, texts] of Object.entries(workload)) {
      for (let repeat = 0; repeat < 2; repeat++) {
        for (const batch of repeat % 2 ? [8, 1] : [1, 8]) {
          const started = performance.now();
          await embed(texts, { role: "document", batch });
          const ms = performance.now() - started;
          batches.push({
            workload: name,
            texts: texts.length,
            batch,
            repeat,
            ms,
            textsPerSecond: texts.length / ms * 1000,
          });
        }
      }
    }
    const documentStart = performance.now();
    const documentVectors = (await embed(docs.map((doc) => doc.text))).vectors;
    const documentEmbeddingMs = performance.now() - documentStart;
    const queryStart = performance.now();
    const queryVectors = (await embed(
      queries.map((query) => query.text),
      { role: "query" },
    )).vectors;
    const queryEmbeddingMs = performance.now() - queryStart;
    await Deno.writeTextFile(
      path.join(root, profile + "-vectors.json"),
      JSON.stringify({ documentVectors, queryVectors }),
    );
    const input = path.join(root, "input");
    const rag = await Rag.init({
      rootDir: input,
      storageDir: path.join(store, "index"),
      ocr: false,
      transcribe: false,
      embedding: ({ texts, role, signal }) => embed(texts, { role, signal }),
      hookVersion: {
        embedding: fast?.hookVersion ?? "xberg-1.3.10-multilingual-512",
      },
      chunking: { maxCharacters: 1200, overlap: 0 },
    });
    const retrieval = [];
    try {
      await rag.addFolder(".");
      embeddingCalls.length = 0;
      const started = performance.now();
      const report = await rag.index();
      const indexMs = performance.now() - started;
      assert.equal(report.failed, 0, JSON.stringify(report));
      assert.equal(report.updated, docs.length);
      indexed = { ms: indexMs, report, calls: structuredClone(embeddingCalls) };
      for (const mode of ["fulltext", "vector", "hybrid"]) {
        const rows = [];
        for (const query of queries) {
          const started = performance.now();
          const result = await rag.search(query.text, {
            mode,
            limit: 5,
            refresh: "none",
          });
          const elapsed = performance.now() - started;
          const relevance = result.hits.map((hit) =>
            hit.citations.some((citation) =>
              path.basename(citation.path).startsWith(query.topic + "-")
            )
          );
          const rank = relevance.indexOf(true);
          rows.push({
            topic: query.topic,
            language: query.language,
            set: query.set,
            ms: elapsed,
            hit1: Number(relevance[0] ?? false),
            hit5: Number(rank >= 0),
            rr: rank >= 0 ? 1 / (rank + 1) : 0,
            paths: result.hits.map((hit) =>
              hit.citations.map((citation) => path.basename(citation.path))
            ),
          });
        }
        const metrics = (group) => ({
          n: group.length,
          hit1: group.reduce((sum, row) => sum + row.hit1, 0) / group.length,
          hit5: group.reduce((sum, row) => sum + row.hit5, 0) / group.length,
          mrr5: group.reduce((sum, row) => sum + row.rr, 0) / group.length,
        });
        retrieval.push({
          mode,
          metrics: metrics(rows),
          latency: stats(rows.map((row) => row.ms)),
          byLanguage: Object.fromEntries(
            [...new Set(queries.map((query) => query.language))].map((
              language,
            ) => [
              language,
              metrics(rows.filter((row) => row.language === language)),
            ]),
          ),
          bySet: Object.fromEntries(
            ["baseline", "holdout"].map((
              set,
            ) => [set, metrics(rows.filter((row) => row.set === set))]),
          ),
          rows,
        });
      }
    } finally {
      await rag.close();
    }
    const result = {
      profile,
      firstInferenceMs,
      setupThroughFirstInferenceMs,
      documentEmbeddingMs,
      queryEmbeddingMs,
      batches,
      indexed,
      retrieval,
      peakRssBytes: Math.max(peakRss, Deno.memoryUsage().rss),
    };
    await Deno.writeTextFile(
      path.join(root, profile + ".json"),
      JSON.stringify(result, null, 2),
    );
    console.log(
      JSON.stringify({
        profile,
        indexMs: indexed.ms,
        retrieval: retrieval.map(({ rows: _rows, ...row }) => row),
      }),
    );
  } finally {
    clearInterval(sample);
    await owner?.close();
    // FastEmbed has no public session close; child exit bounds native resources.
  }
} else {
  await Deno.mkdir(root, { recursive: true });
  await Deno.mkdir(path.join(baseline, "models"), { recursive: true });
  try {
    await Deno.stat(baseModel);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    try {
      await cp(path.resolve("build/oa/e/models/embeddings"), cache, {
        recursive: true,
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const prepared = performance.now();
  await runChild(["prepare"]);
  const prepareModelsMs = performance.now() - prepared;
  const input = path.join(root, "input");
  await Deno.mkdir(input, { recursive: true });
  for (const doc of docs) {
    await Deno.writeTextFile(path.join(input, doc.id + ".txt"), doc.text);
  }
  const modelFiles = {};
  for (
    const name of [
      "model.onnx",
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
    ]
  ) {
    const bytes = await Deno.readFile(path.join(baseModel, name));
    modelFiles[name] = { sha256: hash(bytes), bytes: bytes.length };
  }
  const run = await Deno.makeTempDir({ dir: root, prefix: "run-" });
  const results = [];
  for (const profile of ["xberg", "same-model", "default"]) {
    console.log(
      `Measuring ${profile}: warm batches, fresh indexing, live fulltext/vector/hybrid queries.`,
    );
    await runChild(["worker", profile, path.join(run, profile)]);
    const result = JSON.parse(
      await Deno.readTextFile(path.join(root, profile + ".json")),
    );
    results.push(result);
    console.log(
      JSON.stringify({
        profile,
        indexMs: result.indexed.ms,
        vector: result.retrieval.find((row) => row.mode === "vector").metrics,
      }),
    );
  }
  const xberg = JSON.parse(
    await Deno.readTextFile(path.join(root, "xberg-vectors.json")),
  );
  const fast = JSON.parse(
    await Deno.readTextFile(path.join(root, "same-model-vectors.json")),
  );
  const parity = [];
  for (const kind of ["documentVectors", "queryVectors"]) {
    const similarities = xberg[kind].map((vector, i) =>
      cosine(vector, fast[kind][i])
    );
    parity.push({
      kind,
      n: similarities.length,
      minCosine: Math.min(...similarities),
      meanCosine: similarities.reduce((sum, value) => sum + value, 0) /
        similarities.length,
    });
  }
  const sourceFiles = [
    "tests/benchmark_fastembed.js",
    "tests/fastembed.js",
    "tests/embedding-fixtures.js",
  ];
  const report = {
    measuredAt: new Date().toISOString(),
    platform: Deno.build,
    runtime: Deno.version,
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    productSha256: hash(await Deno.readFile("rag.js")),
    experimentSha256: Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (
          name,
        ) => [name, hash(await Deno.readFile(name))]),
      ),
    ),
    dependencies: FASTEMBED,
    modelFiles,
    prepareModelsMs,
    documents: docs.length,
    queries: queries.length,
    parity,
    results,
    notes: [
      "Same-model comparison uses identical Xberg multilingual-e5-base ONNX/tokenizer files, CPU, 512 token limit, mean pooling, normalization and query:/passage: prefixes. Different runtime/thread/padding defaults remain part of the comparison.",
      "Stock FastEmbed BGE-small-en-v1.5 is a different quantized English 384-dimensional model; its speed is not solely a library improvement over E5-base FP32 768 dimensions.",
      "28 public EN/IT topic documents; 24 earlier IT/EN/RU/ZH questions plus 30 new close-domain questions in IT/EN/RU/ZH/JA. Relevance is authored by topic before evaluation; no tuning. Small diagnostic set, not a human-labelled private-corpus benchmark.",
      "Indexing uses actual Xberg plain-text extraction, embeddings and native Turso publication. Live vector/hybrid queries include actual model inference. No OCR/ASR or private 2.51GB corpus in these timings.",
      "FastEmbed tensor batching is measured separately. Current Rag worker embeds per document, so cross-document batch throughput is not automatically an indexing gain.",
      "Fixed FastEmbed maxLength512 padding performs extra work on short text; Xberg may use shorter dynamic inputs. Long-input runs are truncated to each engine's configured window.",
      "Native providers run in separate sequential child processes; FastEmbed 3.0.0 has no public resource close API. Warm OS caches, no cache eviction. RSS includes each worker's model/native allocations; no GPU test here.",
      "Direct FastEmbed dependency @anush008/tokenizers0.0.0 is archived and publishes Winx64/Linuxx64-gnu/macOS-universal prebuilds, but no Linux ARM64 prebuild. Other OS runtime not tested.",
    ],
  };
  await Deno.writeTextFile(
    path.join(root, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ parity }));
}
