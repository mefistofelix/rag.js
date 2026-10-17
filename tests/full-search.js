// Reopen a completed full-corpus store and measure real model + native search.
// Optional private judgments live in build/full-corpus/queries.json; no private
// query, citation, text or filename is exported to reports by this program.
import * as path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const driver = Deno.args[0], token = Deno.args[1];
assert.ok(["turso", "lancedb"].includes(driver));
assert.match(token, /^[a-z0-9-]+$/);
const runDir = path.resolve("build/full-corpus", token);
const { Rag } = await import(
  pathToFileURL(path.join(runDir, "rag-source.js")).href
);
const read = async (name) =>
  JSON.parse(await Deno.readTextFile(path.join(runDir, name)));
const state = await read(`${driver}.json`);
assert.ok(state.finishedAt, "Only benchmark a completed index");
const config = await read(`${driver}-config.json`);
let queries;
try {
  queries = JSON.parse(
    await Deno.readTextFile("build/full-corpus/queries.json"),
  );
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
  queries = [
    "documenti relativi agli immobili",
    "spese e pagamenti",
    "registrazioni delle conversazioni",
    "corrispondenza e appuntamenti",
  ].map((text, i) => ({ id: `latency-${i}`, text }));
}
const rag = await Rag.init({
  ...config,
  rootDir: path.resolve("build/corpora"),
  storageDir: state.storageDir,
});
const result = {
  driver,
  token,
  indexed: state.status,
  queries: queries.length,
  rows: [],
  embedding: [],
};
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
try {
  // Record cold model/session cost independently of steady-state retrieval.
  let start = performance.now();
  await rag.embed([queries[0].text], { role: "query" });
  result.coldEmbeddingMs = performance.now() - start;
  const modern = typeof rag.listDocuments === "function";
  if (modern) {
    const preflight = JSON.parse(
      await Deno.readTextFile("build/full-corpus/preflight.json"),
    );
    for (
      const folder of new Set(
        preflight.files.map((item) => item.relativePath.split("/")[0]),
      )
    ) await rag.addFolder(folder, { hidden: true });
  }
  if (modern) {
    const aliases = new Map();
    for await (const doc of rag._documents()) {
      const filename = path.resolve("build/corpora", doc.path);
      aliases.set(
        createHash("sha256").update(
          JSON.stringify(["document", pathToFileURL(filename).href]),
        ).digest("hex"),
        doc.id,
      );
      aliases.set(doc.id, doc.id);
    }
    for (const query of queries) {
      if (query.relevantDocumentIds) {
        query.relevantDocumentIds = query.relevantDocumentIds.map((id) =>
          aliases.get(id) ?? id
        );
      }
    }
  }
  const queryProvider = rag._providers;
  const liveEmbed = queryProvider.embed.bind(queryProvider);
  const cachedQueries = new Map();
  for (const query of queries) {
    cachedQueries.set(
      query.text,
      await rag.embed([query.text], { role: "query" }),
    );
  }
  const sources = await rag.listFolders();
  let pdfSource;
  if (modern) {
    for (const source of sources) {
      const page = await rag.listDocuments({
        scope: { sourceIds: [source.id], mime: ["application/pdf"] },
        limit: 1,
      });
      if (page.documents.length) {
        pdfSource = source;
        break;
      }
    }
  } else {pdfSource = sources.find((source) =>
      Object.values(rag._catalog.documents).some((document) =>
        document.state === "ready" && document.mime === "application/pdf" &&
        document.sourceIds.includes(source.id)
      )
    );}
  assert.ok(
    pdfSource,
    "The scoped PDF benchmark needs a source containing PDFs",
  );
  for (const inference of ["live", "cached-query-vector"]) {
    queryProvider.embed = inference === "live"
      ? liveEmbed
      : (texts, options) => {
        assert.equal(options.role, "query");
        assert.equal(texts.length, 1);
        return cachedQueries.get(texts[0]);
      };
    for (const mode of ["fulltext", "vector", "hybrid"]) {
      for (const scoped of [false, true]) {
        const samples = [];
        for (let repeat = 0; repeat < 5; repeat++) {
          for (const [index, query] of queries.entries()) {
            const scope = scoped
              ? { sourceIds: [pdfSource.id], mime: ["application/pdf"] }
              : undefined;
            start = performance.now();
            const found = await rag.search(query.text, {
              mode,
              scope,
              refresh: "none",
              limit: 5,
            });
            const ms = performance.now() - start;
            const judged = !scoped &&
              (Array.isArray(query.relevantChunkIds) ||
                Array.isArray(query.relevantDocumentIds));
            const rank = judged
              ? found.hits.findIndex((hit) =>
                query.relevantChunkIds?.includes(hit.chunkId) ||
                hit.citations.some((citation) =>
                  query.relevantDocumentIds?.includes(citation.documentId)
                )
              )
              : -1;
            samples.push({
              query: index,
              repeat,
              ms,
              hits: found.hits.length,
              hit1: judged ? Number(rank === 0) : undefined,
              hit5: judged ? Number(rank >= 0) : undefined,
              reciprocalRank: judged
                ? (rank < 0 ? 0 : 1 / (rank + 1))
                : undefined,
              chunkIds: found.hits.map((hit) => hit.chunkId),
            });
          }
        }
        const judged = samples.filter((row) => row.hit5 !== undefined);
        const metrics = judged.length
          ? Object.fromEntries(
            ["hit1", "hit5", "reciprocalRank"].map((
              key,
            ) => [
              key,
              judged.reduce((sum, row) => sum + row[key], 0) / judged.length,
            ]),
          )
          : undefined;
        result.rows.push({
          inference,
          mode,
          scoped,
          latency: stats(samples.map((row) => row.ms)),
          metrics,
          samples,
        });
        console.log(
          JSON.stringify({
            driver,
            inference,
            mode,
            scoped,
            latency: result.rows.at(-1).latency,
            metrics,
          }),
        );
      }
    }
  }
  queryProvider.embed = liveEmbed;
  result.catalogBytes = modern
    ? null
    : new TextEncoder().encode(JSON.stringify(rag._catalog)).byteLength;
  for (const query of queries) {
    start = performance.now();
    await rag.embed([query.text], { role: "query" });
    result.embedding.push(performance.now() - start);
  }
  result.warmEmbedding = stats(result.embedding);
  result.qualityNote =
    "Only supplied known-relevant document/chunk judgments are scored. Unjudged queries measure latency only; no general accuracy, answer-level precision or WER is inferred.";
  await Deno.writeTextFile(
    path.join(runDir, `${driver}-search.json`),
    JSON.stringify(result, null, 2),
  );
} finally {
  await rag.close();
}
