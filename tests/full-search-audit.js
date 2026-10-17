// Private, inspectable query/results evidence; public output is aggregates only.
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

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
assert.ok(state.finishedAt);
const config = await read(`${driver}-config.json`);
const questions = JSON.parse(
  await Deno.readTextFile("build/full-corpus/audit-queries.json"),
);
const root = path.resolve("build/corpora");
const rag = await Rag.init({
  ...config,
  rootDir: root,
  storageDir: state.storageDir,
});
const rows = [];
const referenceEvidence = [];
const start = performance.now();
try {
  const modern = typeof rag.listDocuments === "function";
  const documents = new Map();
  if (modern) {
    const preflight = JSON.parse(
      await Deno.readTextFile("build/full-corpus/preflight.json"),
    );
    for (
      const folder of new Set(
        preflight.files.map((item) => item.relativePath.split("/")[0]),
      )
    ) await rag.addFolder(folder, { hidden: true });
    const aliases = new Map();
    for await (const row of rag._documents()) {
      const filename = path.resolve(root, row.path);
      const doc = {
        ...row,
        path: filename,
        state: row.stale ? "pending" : "ready",
        sourceIds: rag._memberships(filename),
      };
      documents.set(doc.id, doc);
      aliases.set(
        createHash("sha256").update(
          JSON.stringify(["document", pathToFileURL(filename).href]),
        ).digest("hex"),
        doc.id,
      );
    }
    for (const question of questions) {
      question.relevantDocumentIds = question.relevantDocumentIds.map((id) =>
        documents.has(id) ? id : aliases.get(id) ?? id
      );
    }
  }
  // Warm the same multilingual query model before timing retrieval.
  await rag.embed([questions[0].text], { role: "query" });
  for (const question of questions) {
    const references = question.relevantDocumentIds.map((id) =>
      modern ? documents.get(id) : rag._catalog.documents[id]
    );
    assert.ok(references.every((document) => document?.state === "ready"));
    const expected = new Set(question.relevantDocumentIds);
    const first = references[0];
    const scopeCases = {
      all: undefined,
      mime: { mime: [first.mime] },
      "source-glob": {
        sourceIds: first.sourceIds,
        include: [first.mime === "application/pdf" ? "**/*.pdf" : "**/*"],
      },
      "exact-paths": {
        paths: references.map((document) => path.relative(root, document.path)),
      },
    };
    for (const document of references) {
      if (referenceEvidence.some((row) => row.documentId === document.id)) {
        continue;
      }
      const revision = modern
        ? null
        : rag._catalog.revisions[document.revisionId];
      const occurrences = modern
        ? await rag._storage.locked(() =>
          rag._storage.db.prepare(
            "SELECT c.id AS chunkId,c.text,l.locator FROM docs_chunks_links l JOIN docs_chunks c ON c.id=l.chunk_id WHERE l.doc_id=? AND l.user_meta_id IS NULL ORDER BY l.ordinal",
          ).all(document.id)
        )
        : revision.occurrences;
      const bytes = await Deno.readFile(document.path);
      const fileHash = createHash("sha256").update(bytes).digest("hex");
      assert.equal(
        fileHash,
        modern
          ? document.content_hash
          : rag._catalog.extractions[revision.extractionId].contentId,
      );
      referenceEvidence.push({
        documentId: document.id,
        path: document.path,
        mime: document.mime,
        fileHashVerified: true,
        chunks: occurrences.map((item) => ({
          chunkId: item.chunkId,
          locator: modern ? JSON.parse(item.locator) : item.locator,
          text: modern ? item.text : rag._catalog.chunks[item.chunkId].text,
        })),
      });
    }
    for (const mode of ["fulltext", "vector", "hybrid"]) {
      for (const [scopeName, scope] of Object.entries(scopeCases)) {
        const started = performance.now();
        const found = await rag.search(question.text, {
          mode,
          scope,
          limit: 5,
          refresh: "none",
        });
        const ms = performance.now() - started;
        for (const hit of found.hits) {
          const storedText = modern
            ? (await rag._storage.locked(() =>
              rag._storage.db.prepare("SELECT text FROM docs_chunks WHERE id=?")
                .get(hit.chunkId)
            )).text
            : rag._catalog.chunks[hit.chunkId].text;
          assert.equal(hit.text, storedText);
          assert.ok(hit.citations.length);
          for (const citation of hit.citations) {
            const document = modern
              ? documents.get(citation.documentId)
              : rag._catalog.documents[citation.documentId];
            if (modern) assert.equal(citation.dataId, document.data_id);
            else assert.equal(citation.revisionId, document.revisionId);
            if (scope?.mime) assert.ok(scope.mime.includes(citation.mime));
            if (scope?.paths) assert.ok(expected.has(citation.documentId));
            if (scope?.sourceIds) {
              assert.ok(
                citation.sourceIds.some((id) => scope.sourceIds.includes(id)),
              );
            }
          }
        }
        const rank = found.hits.findIndex((hit) =>
          hit.citations.some((citation) => expected.has(citation.documentId))
        );
        rows.push({
          id: question.id,
          kind: question.kind,
          question: question.text,
          relevantDocumentIds: question.relevantDocumentIds,
          mode,
          scope: scopeName,
          ms,
          rank: rank < 0 ? null : rank + 1,
          hits: found.hits,
        });
      }
    }
    for (const mode of ["fulltext", "vector", "hybrid"]) {
      const excluded = await rag.search(question.text, {
        mode,
        scope: { paths: [] },
        refresh: "none",
        limit: 5,
      });
      assert.equal(excluded.hits.length, 0);
    }
    console.log(
      JSON.stringify({
        driver,
        auditedQuestions: new Set(rows.map((row) => row.id)).size,
        total: questions.length,
      }),
    );
  }
  const metrics = [];
  for (const kind of [...new Set(questions.map((question) => question.kind))]) {
    for (const mode of ["fulltext", "vector", "hybrid"]) {
      for (const scope of ["all", "mime", "source-glob", "exact-paths"]) {
        const selected = rows.filter((row) =>
          row.kind === kind && row.mode === mode && row.scope === scope
        );
        const times = selected.map((row) => row.ms).sort((a, b) => a - b);
        metrics.push({
          kind,
          mode,
          scope,
          queries: selected.length,
          hit1: selected.filter((row) => row.rank === 1).length /
            selected.length,
          hit5: selected.filter((row) => row.rank !== null).length /
            selected.length,
          mrr5: selected.reduce((sum, row) =>
            sum + (row.rank ? 1 / row.rank : 0), 0) / selected.length,
          medianMs: times[Math.floor(times.length / 2)],
        });
      }
    }
  }
  await Deno.writeTextFile(
    path.join(directory, `${driver}-audit.json`),
    JSON.stringify(
      {
        driver,
        token,
        sourceSha256: state.sourceSha256,
        measuredAt: new Date().toISOString(),
        wallMs: performance.now() - start,
        metrics,
        referenceEvidence,
        rows,
      },
      null,
      2,
    ),
  );
  const lines = [
    `# Private corpus retrieval audit: ${driver}`,
    "",
    "Private queries, excerpts and source links. Do not copy this file into public reports.",
    "",
    "Natural PDF questions, transcript-backed audio questions and corpus-derived lexical controls are scored separately. Audio source fidelity is not judged by this test.",
    "",
  ];
  for (const question of questions) {
    lines.push(
      `## ${question.id} (${question.kind})`,
      "",
      question.text,
      "",
      "Expected source(s):",
      "",
    );
    for (const id of question.relevantDocumentIds) {
      const evidence = referenceEvidence.find((row) => row.documentId === id);
      lines.push(
        `- [Source](<${evidence.path}>) (file hash verified).`,
        "",
        evidence.chunks.slice(0, 2).map((chunk) => chunk.text).join("\n\n")
          .slice(0, 1600),
        "",
      );
    }
    for (
      const row of rows.filter((row) =>
        row.id === question.id && row.scope === "all"
      )
    ) {
      lines.push(
        `### ${row.mode}: expected rank ${row.rank ?? "outside top 5"}`,
        "",
      );
      row.hits.forEach((hit, index) => {
        const citation = hit.citations[0];
        lines.push(
          `${index + 1}. [Source](<${citation.path}>), page ${
            citation.locator?.page ?? "n/a"
          }, audio time ${citation.locator?.start ?? "n/a"}.`,
          "",
          hit.text.slice(0, 1000),
          "",
        );
      });
    }
  }
  await Deno.writeTextFile(
    path.join(directory, `${driver}-audit.md`),
    lines.join("\n"),
  );
} finally {
  await rag.close();
}
