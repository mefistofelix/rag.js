// Independently recompute cosine from the stored float vectors, not DB scores.
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const driver = Deno.args[0], token = Deno.args[1];
assert.ok(["turso", "lancedb"].includes(driver));
assert.match(token, /^[a-z0-9-]+$/);
const directory = path.resolve("build/full-corpus", token);
const read = async (name) =>
  JSON.parse(await Deno.readTextFile(path.join(directory, name)));
const { Rag } = await import(
  pathToFileURL(path.join(directory, "rag-source.js")).href
);
const state = await read(`${driver}.json`);
const config = await read(`${driver}-config.json`);
const rag = await Rag.init({
  ...config,
  rootDir: path.resolve("build/corpora"),
  storageDir: state.storageDir,
});
try {
  const spaceId = rag._providers.spaceId;
  let stored;
  const modern = typeof rag.listDocuments === "function";
  if (modern) {
    const native = await rag._storage.locked(() =>
      rag._storage.db.prepare(
        "SELECT c.id,vector_extract(c.vector) AS value FROM docs_chunks c WHERE c.embedding_key=? AND c.vector IS NOT NULL AND EXISTS(SELECT 1 FROM docs_chunks_links l JOIN docs d ON d.id=l.doc_id WHERE l.chunk_id=c.id)",
      ).all(spaceId)
    );
    stored = native.map((row) => ({
      id: row.id,
      vector: JSON.parse(row.value),
    }));
  } else if (driver === "turso") {
    const rows = await rag._storage.db.prepare(
      "SELECT chunk_id AS id,vector_extract(vector) AS value FROM rag_vectors WHERE space_id=?",
    ).all(spaceId);
    stored = rows.map((row) => ({ id: row.id, vector: JSON.parse(row.value) }));
  } else {
    const table = await rag._storage.table(`vectors_${spaceId}`);
    stored = (await table.query().select(["id", "vector"]).toArray()).map((
      row,
    ) => ({ id: row.id, vector: Array.from(row.vector) }));
  }
  const visible = modern ? new Set(stored.map((row) => row.id)) : new Set(
    Object.values(rag._catalog.documents).filter((document) =>
      document.state === "ready"
    ).flatMap((document) =>
      rag._catalog.revisions[document.revisionId].occurrences.map((
        occurrence,
      ) => occurrence.chunkId)
    ),
  );
  stored = stored.filter((row) => visible.has(row.id));
  assert.equal(stored.length, visible.size);
  const norm = (vector) => Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
  stored.forEach((row) => {
    row.norm = norm(row.vector);
    assert.ok(row.norm > 0);
    assert.equal(row.vector.length, 768);
  });
  const queries = JSON.parse(
    await Deno.readTextFile("build/full-corpus/audit-queries.json"),
  );
  const rows = [];
  for (const index of [0, 4, 6, 12]) {
    const query = queries[index];
    const embedding =
      (await rag.embed([query.text], { role: "query" })).vectors[0];
    const queryNorm = norm(embedding);
    const scores = stored.map((row) => {
      let dot = 0;
      for (let i = 0; i < embedding.length; i++) {
        dot += embedding[i] * row.vector[i];
      }
      return { id: row.id, score: dot / (queryNorm * row.norm) };
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const found = await rag.search(query.text, {
      mode: "vector",
      limit: 5,
      refresh: "none",
    });
    const tolerance = 1e-5;
    let maximumScoreError = 0;
    for (const hit of found.hits) {
      const expected = scores.find((row) => row.id === hit.chunkId);
      assert.ok(expected);
      maximumScoreError = Math.max(
        maximumScoreError,
        Math.abs(expected.score - hit.score),
      );
      assert.ok(Math.abs(expected.score - hit.score) < tolerance);
      assert.ok(
        expected.score >= scores[4].score - tolerance,
        "Native result must be in the mathematical top five, allowing float ties",
      );
    }
    rows.push({
      queryIndex: index,
      vectors: stored.length,
      maximumScoreError,
      top5WithinFloatTolerance: true,
    });
  }
  await Deno.writeTextFile(
    path.join(directory, `${driver}-vector-oracle.json`),
    JSON.stringify(
      {
        driver,
        sourceSha256: state.sourceSha256,
        dimensions: 768,
        tolerance: 1e-5,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      driver,
      verifiedQueries: rows.length,
      storedVectors: stored.length,
      maximumScoreError: Math.max(...rows.map((row) => row.maximumScoreError)),
    }),
  );
} finally {
  await rag.close();
}
