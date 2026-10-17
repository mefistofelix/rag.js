// Private corpus integration check. Never print queries, filenames or transcripts.
import assert from "node:assert/strict";
import * as path from "node:path";
import { cp } from "node:fs/promises";
import { Rag } from "../rag.js";

const corpusRoot = path.resolve("build/corpora");
const selection = JSON.parse(
  await Deno.readTextFile(Deno.args[0] ?? "build/corpora/smoke-selection.json"),
);
const samples = selection.map((item) => item.path.replaceAll("\\", "/"));
if (!samples.length) {
  throw new Error("Select local corpus files before this explicit test");
}
const embeddingDirectory = await Deno.makeTempDir({
  dir: path.resolve("build"),
  prefix: "embedding-smoke-native-",
});
for await (const entry of Deno.readDir("build")) {
  if (entry.isDirectory && entry.name.startsWith("embedding-smoke-")) {
    await Deno.mkdir(path.join(embeddingDirectory, "models"), {
      recursive: true,
    });
    try {
      await cp(
        path.resolve("build", entry.name, "models/embeddings"),
        path.join(embeddingDirectory, "models/embeddings"),
        { recursive: true },
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    break;
  }
}
const embeddingOwner = await Rag.init({
  storageDir: embeddingDirectory,
  ocr: false,
});
const results = [];
let query;
let baseline;
try {
  for (const driver of ["turso"]) {
    const storageDir = await Deno.makeTempDir({
      dir: path.resolve("build"),
      prefix: `corpus-${driver}-`,
    });
    const tessdata = path.join(storageDir, "models/tessdata");
    await Deno.mkdir(tessdata, { recursive: true });
    for (const language of ["Latin", "Cyrillic", "Arabic", "chi_sim"]) {
      try {
        await Deno.copyFile(
          `build/models/tessdata/${language}.traineddata`,
          path.join(tessdata, `${language}.traineddata`),
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    const rag = await Rag.init({
      rootDir: corpusRoot,
      storageDir,
      storage: { driver },
      embedding: async ({ texts, role, signal }) =>
        await embeddingOwner.embed(texts, { role, signal }),
      hookVersion: { embedding: "xberg-multilingual-e5-smoke-v1" },
      transcribe: {
        modelPath: path.resolve("build/models/whisper/ggml-tiny.bin"),
      },
      indexing: {
        maxFileBytes: 500_000,
        maxPages: 10,
        audio: { maxFileBytes: 500_000, maxDurationSeconds: 60 },
      },
    });
    try {
      await rag.addFolder(".", { include: samples });
      let started = performance.now();
      const report = await rag.index();
      const indexMs = performance.now() - started;
      started = performance.now();
      const unchanged = await rag.index();
      const unchangedMs = performance.now() - started;
      assert.equal(unchanged.embeddingsGenerated, 0);
      const status = await rag.status();
      assert.ok(
        status.states.ready > 0,
        "some selected corpus documents must index successfully",
      );
      if (!query) {
        const chunks = await rag._storage.locked(() =>
          rag._storage.db.prepare(
            "SELECT text FROM docs_chunks WHERE text IS NOT NULL LIMIT 100",
          ).all()
        );
        const chunk = chunks.find((item) => /\p{L}{5}/u.test(item.text));
        if (!chunk) throw new Error("No searchable corpus text extracted");
        query = chunk.text.match(/\p{L}{5,}/u)[0];
      }
      const lexical = await rag.search(query, { mode: "fulltext" });
      assert.ok(lexical.hits.length > 0);
      assert.ok(lexical.hits[0].score > 0);
      const vector = await rag.search(query, { mode: "vector", limit: 3 });
      assert.ok(vector.hits.length > 0);
      const timings = [];
      for (const mode of ["fulltext", "vector", "hybrid"]) {
        const latencies = [];
        for (let i = 0; i < 12; i++) {
          const start = performance.now();
          const response = await rag.search(query, {
            mode,
            limit: 3,
            refresh: "none",
          });
          latencies.push(performance.now() - start);
          assert.ok(response.hits.length > 0);
        }
        latencies.sort((a, b) => a - b);
        timings.push({
          mode,
          n: latencies.length,
          medianMs: latencies[5],
          p95Ms: latencies[11],
        });
      }
      if (baseline) {
        assert.equal(status.counts.documents, baseline.documents);
        assert.equal(status.counts.chunks, baseline.chunks);
        assert.equal(
          vector.hits[0].chunkId,
          baseline.topVectorChunk,
          "same vectors and scope must give the same exact cosine winner",
        );
      } else {baseline = {
          documents: status.counts.documents,
          chunks: status.counts.chunks,
          topVectorChunk: vector.hits[0].chunkId,
        };}
      const summary = {
        driver,
        selectedFiles: samples.length,
        indexMs,
        unchangedMs,
        search: timings,
        index: {
          ...report,
          errors: report.errors.map((item) => ({ code: item.code })),
        },
        counts: status.counts,
        states: status.states,
        lexicalHits: lexical.hits.length,
        vectorHits: vector.hits.length,
        topVectorChunk: vector.hits[0].chunkId,
      };
      results.push(summary);
      console.log(JSON.stringify({ ...summary, topVectorChunk: undefined }));
    } finally {
      await rag.close();
    }
  }
} finally {
  await embeddingOwner.close();
}
await Deno.writeTextFile(
  "build/results/rag-corpus.json",
  JSON.stringify(results, null, 2),
);
