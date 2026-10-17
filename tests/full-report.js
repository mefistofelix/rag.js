// Publish aggregates only after both complete native runs and search probes.
import * as path from "node:path";
import assert from "node:assert/strict";

const token = Deno.args[0];
assert.match(token, /^[a-z0-9-]+$/);
const directory = path.resolve("build/full-corpus", token);
const read = async (name) =>
  JSON.parse(await Deno.readTextFile(path.join(directory, name)));
const preflight = JSON.parse(
  await Deno.readTextFile("build/full-corpus/preflight.json"),
);
const drivers = [];
async function bytes(directory, excluded = []) {
  let total = 0;
  for await (const item of Deno.readDir(directory)) {
    if (excluded.includes(item.name)) continue;
    const filename = path.join(directory, item.name);
    total += item.isDirectory
      ? await bytes(filename)
      : (await Deno.stat(filename)).size;
  }
  return total;
}
for (const driver of ["turso", "lancedb"]) {
  const state = await read(`${driver}.json`);
  const search = await read(`${driver}-search.json`);
  assert.ok(state.finishedAt);
  assert.equal(state.completedIds.length, preflight.summary.files);
  const config = await read(`${driver}-config.json`);
  const fileMap = new Map(preflight.files.map((item) => [item.id, item]));
  const byExtension = {};
  for (const record of state.records) {
    const extension =
      path.extname(fileMap.get(record.id).relativePath).toLowerCase() ||
      "(none)";
    const group = byExtension[extension] ??= { files: 0, bytes: 0, wallMs: 0 };
    group.files++;
    group.bytes += record.bytes;
    group.wallMs += record.wallMs;
  }
  const errors = {};
  for (const batch of state.batches) {
    for (const error of batch.report.errors) {
      errors[error.code] = (errors[error.code] ?? 0) + 1;
    }
  }
  drivers.push({
    driver,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    sourceSha256: state.sourceSha256,
    setupMs: state.setupMs,
    indexMs: state.indexingMs,
    wallMs: Date.parse(state.finishedAt) - Date.parse(state.startedAt),
    unchangedMs: state.unchangedMs,
    counts: state.status.counts,
    states: state.status.states,
    emptyReadyDocuments: state.emptyReadyDocuments,
    chunkTextCharacters: state.chunkTextCharacters,
    phases: state.phases,
    byExtension,
    errorCodes: errors,
    catalogBytes: search.catalogBytes,
    nativeStorageBytes: await bytes(state.storageDir, ["models", "tmp"]),
    modelStorageBytes: await bytes(path.join(state.storageDir, "models")),
    configuration: {
      ocr: config.ocr,
      transcribe: config.transcribe,
      indexing: config.indexing,
    },
    search: {
      distinctQueries: search.queries,
      coldEmbeddingMs: search.coldEmbeddingMs,
      warmEmbedding: search.warmEmbedding,
      rows: search.rows.map((
        { inference, mode, scoped, latency, metrics },
      ) => ({ inference, mode, scoped, latency, metrics })),
      note: search.qualityNote,
    },
  });
}
assert.equal(drivers[0].sourceSha256, drivers[1].sourceSha256);
assert.deepEqual(drivers[0].configuration, drivers[1].configuration);
const raw = {
  date: "2026-10-15",
  target: "Windows x64",
  deno: "2.9.7",
  cpu: "Intel Core i7-11800H",
  gpu: "NVIDIA RTX 3050 Laptop, 4 GiB",
  packages: {
    xberg: "1.3.10",
    nodeAv: "6.1.1",
    turso: "0.8.3",
    lancedb: "0.40.0",
  },
  corpus: preflight.summary,
  drivers,
};
await Deno.writeTextFile(
  "reports/full-corpus-2026-10-15.json",
  JSON.stringify(raw, null, 2),
);
console.log("Published sanitized complete-corpus JSON measurements.");
