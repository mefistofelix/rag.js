// Compare coordination work on the same generated corpus, without model noise.
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

if (!Deno.args[0]) {
  throw new Error("Supply the baseline rag.js path explicitly");
}
const modules = [];
for (
  const [name, filename] of [
    ["before", Deno.args[0]],
    ["after", "rag.js"],
  ]
) {
  const source = await Deno.readFile(filename);
  const text = new TextDecoder().decode(source);
  const ragText = text.slice(text.indexOf("export class Rag {"));
  const methods = [
    ...ragText.matchAll(/^ {2}(?:(?:static|async) )*\*?(\w+)\(/gm),
  ];
  const methodBytes = Object.fromEntries(methods.map((match, index) => [
    match[1],
    new TextEncoder().encode(ragText.slice(
      match.index,
      methods[index + 1]?.index ?? ragText.length,
    )).length,
  ]));
  const sectionHash = (start, end) =>
    createHash("sha256").update(
      text.slice(text.indexOf(start), text.indexOf(end)),
    ).digest("hex");
  const { Rag } = await import(pathToFileURL(path.resolve(filename)).href);
  modules.push({
    name,
    Rag,
    bytes: source.length,
    sha256: createHash("sha256").update(source).digest("hex"),
    orchestrationBytes: new TextEncoder().encode(ragText).length,
    methodBytes,
    adapterSha256: sectionHash("class TursoStorage", "class ContentProviders"),
    providersSha256: sectionHash(
      "class ContentProviders",
      "async function sampleFile",
    ),
    revisionPolicySha256: sectionHash(
      "async function sampleFile",
      "export class Rag {",
    ),
  });
}
for (
  const key of ["adapterSha256", "providersSha256", "revisionPolicySha256"]
) {
  assert.equal(
    modules[0][key],
    modules[1][key],
    `${key} changed outside coordination`,
  );
}
if (Deno.args[1] === "--publish") {
  assert.equal(
    modules[0].sha256,
    "f5cab88607a16020f81fa6c355b69faf03fed4242ebaf578c200622ac1dcc651",
    "The published comparison requires the recorded baseline",
  );
}
const directory = path.resolve(
  await Deno.makeTempDir({ dir: "build", prefix: "runtime-" }),
);
const rows = [];
for (const count of [128, 512]) {
  const rootDir = path.join(directory, String(count));
  await Deno.mkdir(rootDir);
  for (let index = 0; index < count; index++) {
    await Deno.writeTextFile(
      path.join(rootDir, `${String(index).padStart(5, "0")}.txt`),
      "science library",
    );
  }
  // Reverse the order at the second size to reduce a consistent startup bias.
  for (const module of count === 128 ? modules : [...modules].reverse()) {
    const rag = await module.Rag.init({
      rootDir,
      storageDir: path.join(directory, `${count}-${module.name}`),
      ocr: false,
      transcribe: false,
      embedding: false,
      cache: { extractionContext: "content" },
      hookVersion: { extract: "runtime-benchmark-v1" },
      extract: async ({ input }) => ({
        mime: "text/plain",
        units: [{ text: await Deno.readTextFile(input.path) }],
      }),
    });
    let stateLookups = 0;
    let outcomeReads = 0;
    const state = rag._state.bind(rag);
    const observed = new WeakSet();
    rag._state = (id) => {
      stateLookups++;
      const record = state(id);
      if (!observed.has(record)) {
        observed.add(record);
        let outcome = record.outcome;
        Object.defineProperty(record, "outcome", {
          get() {
            outcomeReads++;
            return outcome;
          },
          set(value) {
            outcome = value;
          },
          configurable: true,
        });
      }
      return record;
    };
    try {
      await rag.addFolder(".");
      const started = performance.now();
      const report = await rag.index();
      const indexMs = performance.now() - started;
      assert.equal(report.updated, count);
      assert.equal(report.failed, 0);
      assert.equal(report.complete, true);
      const coordination = { stateLookups, outcomeReads };
      const found = await rag.search("science", {
        mode: "fulltext",
        refresh: "none",
      });
      assert.equal(found.hits.length, 1);
      assert.equal(found.hits[0].citations.length, count);
      assert.equal(
        new Set(found.hits[0].citations.map((item) => item.relativePath)).size,
        count,
      );
      const counts = (await rag.status()).counts;
      assert.equal(counts.stale, 0);
      assert.equal(counts.extractions, 1);
      assert.equal(counts.chunks, 1);
      rows.push({
        variant: module.name,
        documents: count,
        indexMs,
        coordination,
        assertions: {
          allDocumentsPublished: true,
          fulltextSearch: true,
          everyPathCited: true,
          extractionAndChunkDedup: true,
        },
      });
      console.log(JSON.stringify(rows.at(-1)));
    } finally {
      await rag.close();
    }
  }
}
const comparisons = [128, 512].map((count) => {
  const before = rows.find((row) =>
    row.documents === count && row.variant === "before"
  );
  const after = rows.find((row) =>
    row.documents === count && row.variant === "after"
  );
  assert.ok(
    after.coordination.outcomeReads < before.coordination.outcomeReads / 4,
  );
  assert.ok(after.coordination.stateLookups < before.coordination.stateLookups);
  return {
    documents: count,
    outcomeReadReduction: 1 -
      after.coordination.outcomeReads / before.coordination.outcomeReads,
    stateLookupReduction: 1 -
      after.coordination.stateLookups / before.coordination.stateLookups,
  };
});
const report = {
  measuredAt: new Date().toISOString(),
  runtime: Deno.version,
  platform: Deno.build,
  turso: "0.8.3",
  modules: modules.map(({ Rag: _, ...module }) => module),
  conditions:
    "Generated identical text files; one serialized worker; native Turso; no OCR/ASR/embeddings; outcome getter and state lookup instrumented equally. One run per size/variant. Timings are not a general speedup estimate.",
  rows,
  comparisons,
};
await Deno.writeTextFile(
  "build/results/benchmark-runtime.json",
  JSON.stringify(report, null, 2),
);
if (Deno.args[1] === "--publish") {
  const core = JSON.parse(
    await Deno.readTextFile("build/results/core-contracts-v2.json"),
  );
  assert.equal(core.productSha256, modules[1].sha256);
  assert.ok(core.passed >= 27);
  assert.equal(core.failed, 0);
  await Deno.writeTextFile(
    "reports/runtime-coordination-2026-10-17.json",
    JSON.stringify(
      {
        ...report,
        core,
        unchangedAdapterProvidersAndRevisionPolicy: true,
        notRerun: [
          "native OCR/ASR experiments",
          "full private corpus",
          "experimental providers",
        ],
      },
      null,
      2,
    ),
  );
}
