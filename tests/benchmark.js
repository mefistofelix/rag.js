// Reproducible public fixtures. Private corpus contents never enter this report.
import assert from "node:assert/strict";
import * as path from "node:path";
import os from "node:os";
import { cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { embeddingTopics } from "./embedding-fixtures.js";

const productPath = path.resolve(Deno.env.get("RAG_BENCH_MODULE") ?? "rag.js");
const { Rag } = await import(pathToFileURL(productPath).href);

const kind = Deno.args[0] ?? "storage";
const label = Deno.args[1] ?? "current";
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Invalid report label");
// Leave room for native Windows Lance fragment filenames below this directory.
const root = path.resolve("build/bm", crypto.randomUUID().slice(0, 8));
await Deno.mkdir(root, { recursive: true });
await Deno.mkdir("build/results", { recursive: true });

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return {
    n: values.length,
    medianMs: quantile(0.5),
    p95Ms: quantile(0.95),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

async function timed(operation) {
  const start = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - start };
}

async function diskBytes(directory) {
  let bytes = 0;
  for await (const item of Deno.readDir(directory)) {
    const filename = path.join(directory, item.name);
    bytes += item.isDirectory
      ? await diskBytes(filename)
      : (await Deno.stat(filename)).size;
  }
  return bytes;
}

function instrument(rag) {
  const totals = {};
  for (
    const [owner, names] of [
      [rag, ["_scan"]],
      [rag._storage, ["publish", "retrieve"]],
      [rag._providers, ["classify", "extract", "embed"]],
      ...(rag._queryProviders ? [[rag._queryProviders, ["embed"]]] : []),
    ]
  ) {
    for (const name of names) {
      const original = owner[name].bind(owner);
      owner[name] = async (...args) => {
        const start = performance.now();
        try {
          return await original(...args);
        } finally {
          totals[name] ??= { calls: 0, ms: 0 };
          totals[name].calls++;
          totals[name].ms += performance.now() - start;
        }
      };
    }
  }
  return {
    reset() {
      for (const key of Object.keys(totals)) delete totals[key];
    },
    snapshot() {
      return structuredClone(totals);
    },
  };
}

function vectorFor(text) {
  const key = text.match(/record\d{8}/)?.[0] ?? text;
  const seed = createHash("sha256").update(key).digest();
  let state =
    new DataView(seed.buffer, seed.byteOffset, seed.byteLength).getUint32(0) ||
    1;
  return Array.from({ length: 768 }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.fround((state >>> 0) / 2147483648 - 1);
  });
}

function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }
  return dot / Math.sqrt(normA * normB);
}

const results = [];
const metadata = {
  kind,
  label,
  time: new Date().toISOString(),
  deno: Deno.version,
  platform: Deno.build,
  cpu: os.cpus()[0]?.model.replaceAll("\u0000", "").trim(),
  logicalCpus: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  productSha256: createHash("sha256").update(await Deno.readFile(productPath))
    .digest("hex"),
  conditions:
    "Sequential single client; warm filesystem/model caches, no OS cache eviction; downloads may run concurrently. Stage timings overlap where a provider delegates. RSS is process-wide, not per database.",
};
async function save() {
  await Deno.writeTextFile(
    `build/results/benchmark-${kind}-${label}.json`,
    JSON.stringify({ metadata, results }, null, 2),
  );
}

if (kind === "storage") {
  const sizes = (Deno.env.get("RAG_BENCH_SIZES") ?? "100,1000,10000").split(",")
    .map(Number);
  const repeats = Number(Deno.env.get("RAG_BENCH_REPEATS") ?? 12);
  for (const size of sizes) {
    const input = path.join(root, `input-${size}`);
    await Deno.mkdir(input);
    const text = (i) =>
      `record${String(i).padStart(8, "0")} sharedtopic category${
        i % 20
      } science contracts gardens`;
    for (let i = 0; i < size; i++) {
      await Deno.writeTextFile(path.join(input, `${i}.txt`), text(i));
    }
    const storageDir = path.join(root, `turso-${size}`);
    let extractionCalls = 0, embeddingInputs = 0;
    const config = {
      rootDir: input,
      storageDir,
      ocr: false,
      transcribe: false,
      worker: { idleMs: 25 },
      cache: { extractionContext: "content" },
      extract: async ({ input }) => {
        extractionCalls++;
        return {
          mime: "text/plain",
          units: [{ text: await Deno.readTextFile(input.path) }],
        };
      },
      embedding: ({ texts }) => {
        embeddingInputs += texts.length;
        return { vectors: texts.map(vectorFor) };
      },
      hookVersion: {
        extract: "public-plain-v2",
        embedding: "deterministic-768-v1",
      },
    };
    let rag = await Rag.init(config);
    const row = { driver: "turso", documents: size, dimensions: 768 };
    try {
      await rag.addFolder(".");
      let measured = await timed(() => rag.index());
      assert.equal(measured.value.failed, 0, JSON.stringify(measured.value));
      row.indexMs = measured.ms;
      row.indexReport = measured.value;
      measured = await timed(() => rag.index());
      assert.equal(measured.value.updated, 0);
      row.unchangedMs = measured.ms;
      const queries = [text(0), text(Math.floor(size / 2)), text(size - 1)];
      const stored = await rag._storage.locked(() =>
        rag._storage.db.prepare(
          "SELECT id,text,vector_extract(vector) AS value FROM docs_chunks WHERE vector IS NOT NULL",
        ).all()
      );
      for (const query of queries) {
        const expected = stored.map((item) => ({
          id: item.id,
          score: cosine(vectorFor(query), JSON.parse(item.value)),
        }))
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(
            0,
            5,
          );
        const result = await rag.search(query, {
          mode: "vector",
          limit: 5,
          refresh: "none",
        });
        assert.deepEqual(
          result.hits.map((hit) => hit.chunkId),
          expected.map((hit) => hit.id),
        );
        result.hits.forEach((hit, i) =>
          assert.ok(Math.abs(hit.score - expected[i].score) < 1e-5)
        );
      }
      row.independentCosineQueries = queries.length;
      row.search = [];
      for (const mode of ["fulltext", "vector", "hybrid"]) {
        const times = [];
        for (let i = 0; i < repeats; i++) {
          const result = await timed(() =>
            rag.search(queries[i % queries.length], {
              mode,
              limit: 5,
              refresh: "none",
            })
          );
          assert.ok(result.value.hits.length);
          times.push(result.ms);
        }
        row.search.push({ mode, ...stats(times) });
      }
      const before = { extractionCalls, embeddingInputs };
      await Deno.writeTextFile(path.join(input, "0.txt"), text(0) + " changed");
      measured = await timed(() => rag.index({ scope: { paths: ["0.txt"] } }));
      row.oneChanged = {
        ms: measured.ms,
        extractionCalls: extractionCalls - before.extractionCalls,
        embeddingInputs: embeddingInputs - before.embeddingInputs,
        report: measured.value,
      };
      assert.equal(row.oneChanged.extractionCalls, 1);
      assert.equal(row.oneChanged.embeddingInputs, 1);
      await rag.close();
      measured = await timed(() => Rag.init(config));
      rag = measured.value;
      row.reopenMs = measured.ms;
      assert.equal((await rag.listFolders()).length, 0);
      assert.equal((await rag.status()).counts.documents, size);
      row.diskBytes = await diskBytes(storageDir);
      row.memory = Deno.memoryUsage();
      row.note =
        "Synthetic deterministic vectors isolate storage/scheduler cost; no OCR/ASR or real model inference. Search skips filesystem refresh; OS cache is warm. RSS is process-wide.";
      results.push(row);
      await save();
      console.log(
        JSON.stringify({
          documents: size,
          indexMs: row.indexMs,
          oneChangedMs: row.oneChanged.ms,
          search: row.search,
        }),
      );
    } finally {
      await rag.close();
    }
  }
} else if (kind === "quality") {
  const topics = embeddingTopics;
  const input = path.join(root, "input");
  await Deno.mkdir(input);
  for (const [id, en, it] of topics) {
    await Deno.writeTextFile(path.join(input, `${id}-en.txt`), en);
    await Deno.writeTextFile(path.join(input, `${id}-it.txt`), it);
  }
  const queries = topics.flatMap((
    [topic, , , it, en, other],
    i,
  ) => [{ topic, query: it, language: "it" }, {
    topic,
    query: en,
    language: "en",
  }, { topic, query: other, language: i % 2 ? "zh" : "ru" }]);
  const ownerDirectory = path.join(root, "embedding-owner");
  for await (const entry of Deno.readDir("build")) {
    if (entry.isDirectory && entry.name.startsWith("embedding-smoke-")) {
      try {
        await Deno.mkdir(path.join(ownerDirectory, "models"), {
          recursive: true,
        });
        await cp(
          path.resolve("build", entry.name, "models/embeddings"),
          path.join(ownerDirectory, "models/embeddings"),
          { recursive: true },
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      break;
    }
  }
  const owner = await Rag.init({ storageDir: ownerDirectory, ocr: false });
  try {
    const modelFirst = await timed(() =>
      owner.embed(["Warm multilingual model"], { role: "query" })
    );
    metadata.modelFirstObservedMs = modelFirst.ms;
    const texts = topics.flatMap(([, en, it]) => [en, it]);
    const embedDocuments = await timed(() => owner.embed(texts));
    const embedQueries = await timed(() =>
      owner.embed(queries.map((item) => item.query), { role: "query" })
    );
    const documentVectors = new Map(
      texts.map((text, index) => [text, embedDocuments.value.vectors[index]]),
    );
    const queryVectors = new Map(
      queries.map((
        item,
        index,
      ) => [item.query, embedQueries.value.vectors[index]]),
    );
    metadata.embedding = {
      dimensions: embedDocuments.value.vectors[0].length,
      documents: texts.length,
      documentBatchMs: embedDocuments.ms,
      queries: queries.length,
      queryBatchMs: embedQueries.ms,
      model: "Xberg multilingual preset, E5 document/query roles",
    };
    for (const driver of ["turso"]) {
      let liveEmbedding = false;
      const rag = await Rag.init({
        rootDir: input,
        storageDir: path.join(root, driver),
        storage: { driver },
        ocr: false,
        embedding: async ({ texts, role, signal }) =>
          liveEmbedding ? await owner.embed(texts, { role, signal }) : {
            vectors: texts.map((text) =>
              (role === "query" ? queryVectors : documentVectors).get(text)
            ),
          },
        hookVersion: { embedding: "benchmark-real-e5-multilingual-v1" },
      });
      try {
        await rag.addFolder(".");
        const indexed = await timed(() => rag.index());
        assert.equal(indexed.value.failed, 0);
        for (const mode of ["fulltext", "vector", "hybrid"]) {
          const rows = [];
          for (const item of queries) {
            const response = await timed(() =>
              rag.search(item.query, { mode, limit: 5, refresh: "none" })
            );
            const relevant = (hit) =>
              hit.citations.some((citation) =>
                path.basename(citation.path).startsWith(`${item.topic}-`)
              );
            const relevance = response.value.hits.map(relevant);
            const first = relevance.indexOf(true);
            const dcg = relevance.reduce(
              (sum, value, rank) => sum + (value ? 1 / Math.log2(rank + 2) : 0),
              0,
            );
            rows.push({
              topic: item.topic,
              language: item.language,
              ms: response.ms,
              hit1: relevance[0] ? 1 : 0,
              hit5: first >= 0 ? 1 : 0,
              reciprocalRank: first >= 0 ? 1 / (first + 1) : 0,
              recall5: relevance.filter(Boolean).length / 2,
              ndcg5: dcg / (1 + 1 / Math.log2(3)),
            });
          }
          const average = (key, group = rows) =>
            group.reduce((sum, row) => sum + row[key], 0) / group.length;
          const result = {
            driver,
            mode,
            indexMs: indexed.ms,
            indexReport: indexed.value,
            metrics: Object.fromEntries(
              ["hit1", "hit5", "reciprocalRank", "recall5", "ndcg5"].map((
                key,
              ) => [key, average(key)]),
            ),
            latency: stats(rows.map((row) => row.ms)),
            byLanguage: Object.fromEntries(
              ["it", "en", "ru", "zh"].map((language) => {
                const group = rows.filter((row) => row.language === language);
                return [language, {
                  n: group.length,
                  hit1: average("hit1", group),
                  hit5: average("hit5", group),
                  mrr5: average("reciprocalRank", group),
                }];
              }),
            ),
            rows,
          };
          results.push(result);
          await save();
          console.log(
            JSON.stringify({
              driver,
              mode,
              metrics: result.metrics,
              latency: result.latency,
            }),
          );
        }
        // Charge real query inference on each call in this separate E2E profile.
        liveEmbedding = true;
        const phases = instrument(rag);
        const endToEnd = [];
        for (const mode of ["fulltext", "vector", "hybrid"]) {
          phases.reset();
          const latencies = [];
          for (const item of queries.slice(0, 12)) {
            const response = await timed(() =>
              rag.search(item.query, { mode, limit: 5, refresh: "none" })
            );
            latencies.push(response.ms);
          }
          endToEnd.push({
            mode,
            ...stats(latencies),
            stages: phases.snapshot(),
          });
        }
        results.push({
          driver,
          endToEnd,
          note:
            "Real Xberg query inference on every vector/hybrid request; warm model, 12 distinct queries.",
        });
        await save();
      } finally {
        await rag.close();
      }
    }
  } finally {
    await owner.close();
  }
} else if (kind === "primitives") {
  const filename = path.join(root, "hash-input.bin");
  const block = Uint8Array.from(
    { length: 1024 * 1024 },
    (_, index) => index % 251,
  );
  const file = await Deno.open(filename, { createNew: true, write: true });
  try {
    for (let index = 0; index < 64; index++) {
      let offset = 0;
      while (offset < block.length) {
        offset += await file.write(block.subarray(offset));
      }
    }
    await file.sync();
  } finally {
    file.close();
  }
  for (const withHash of [false, true]) {
    const values = [];
    let digest;
    for (let run = 0; run < 5; run++) {
      const response = await timed(async () => {
        const file = await Deno.open(filename);
        const hash = withHash ? createHash("sha256") : null;
        let bytes = 0;
        for await (const block of file.readable) {
          hash?.update(block);
          bytes += block.length;
        }
        assert.equal(bytes, 64 * 1024 * 1024);
        return hash?.digest("hex");
      });
      if (digest) assert.equal(response.value, digest);
      digest = response.value;
      values.push(response.ms);
    }
    const timing = stats(values);
    results.push({
      operation: withHash ? "file-read-and-sha256" : "file-read",
      bytes: 64 * 1024 * 1024,
      ...timing,
      MiBPerSecond: 64 / (timing.medianMs / 1000),
    });
  }
  const text = "Public benchmark chunk text. ".repeat(44).slice(0, 1200);
  const response = await timed(() => {
    for (let i = 0; i < 10_000; i++) {
      createHash("sha256").update(JSON.stringify([1, text + i])).digest("hex");
    }
  });
  results.push({
    operation: "chunk-sha256",
    chunks: 10_000,
    charactersPerChunk: 1200,
    ms: response.ms,
  });
} else throw new Error("Use storage, quality or primitives");
await save();
console.log(
  `Benchmark completed: ${kind}/${label}, ${results.length} result rows.`,
);
