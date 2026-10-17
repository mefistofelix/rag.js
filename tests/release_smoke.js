// Public multilingual fixtures exercised through a source or packed entry point.
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  args,
  fs,
  name,
  platform,
  runtime,
  temporaryDirectory,
} from "./test_runtime.js";

const modulePath = path.resolve(args[0] ?? "rag.js");
const label = args[1] ?? "source";
assert.match(label, /^[a-z0-9-]+$/i);
const { Rag, VERSION } = await import(pathToFileURL(modulePath).href);
await fs.mkdir("build/release", { recursive: true });
const rootDir = await temporaryDirectory({
  dir: path.resolve("build/release"),
  prefix: `${name}-smoke-`,
});
await fs.mkdir(path.join(rootDir, "docs"));
for (
  const [filename, text] of [
    [
      "library.txt",
      "La biblioteca conserva libri di astronomia e manoscritti antichi.",
    ],
    [
      "contract.txt",
      "Il contratto di locazione prevede il rinnovo dell'affitto e il pagamento del canone.",
    ],
    [
      "ocean.txt",
      "The oceanography expedition studies coral reefs and marine ecosystems.",
    ],
  ]
) await fs.writeFile(path.join(rootDir, "docs", filename), text);

const storageDir = path.join(rootDir, "storage");
const cachedModel = path.resolve("build/oa/e/models/embeddings");
try {
  await fs.cp(cachedModel, path.join(storageDir, "models/embeddings"), {
    recursive: true,
  });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const rag = await Rag.init({ rootDir, storageDir });
const checks = [];
try {
  await rag.addFolder("docs");
  const indexed = await rag.index();
  assert.equal(indexed.failed, 0, JSON.stringify(indexed.errors));
  assert.equal(indexed.updated, 3);
  assert.equal((await rag.index()).unchanged, 3);
  for (
    const [query, filename] of [
      ["Where can I find books about astronomy?", "library.txt"],
      ["Как продлить договор аренды?", "contract.txt"],
      ["La spedizione studia le barriere coralline", "ocean.txt"],
    ]
  ) {
    const branches = {};
    for (const mode of ["vector", "fulltext", "hybrid"]) {
      branches[mode] =
        (await rag.search(query, { mode, refresh: "none", limit: 3 })).hits;
    }
    assert.equal(path.basename(branches.vector[0].citations[0].path), filename);
    const scores = new Map();
    for (const branch of [branches.vector, branches.fulltext]) {
      branch.forEach((hit, rank) =>
        scores.set(
          hit.chunkId,
          (scores.get(hit.chunkId) ?? 0) + 1 / (61 + rank),
        )
      );
    }
    const expected = [...scores].sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0])
    );
    assert.deepEqual(
      branches.hybrid.map((hit) => hit.chunkId),
      expected.map(([id]) => id),
    );
    branches.hybrid.forEach((hit, index) =>
      assert.ok(Math.abs(hit.score - expected[index][1]) < 1e-12)
    );
    checks.push({
      expected: filename,
      vectorRank: 1,
      hybridRank: branches.hybrid.findIndex((hit) =>
        path.basename(hit.citations[0].path) === filename
      ) + 1,
      hybridFusionVerified: true,
    });
  }
  const lexical = await rag.search("coral", {
    mode: "fulltext",
    refresh: "none",
  });
  assert.equal(path.basename(lexical.hits[0].citations[0].path), "ocean.txt");
  const embedding = await rag.embed(["The library", "La biblioteca"]);
  assert.equal(embedding.vectors.length, 2);
  assert.equal(embedding.vectors[0].length, 768);
  const ocr = await rag.ocr(path.resolve("build/fixtures/en.png"));
  assert.match(ocr.text.toLowerCase(), /library/);
  const transcript = await rag.transcribe(
    path.resolve("build/fixtures/speech-en.m4a"),
  );
  assert.match(transcript.text.toLowerCase(), /library/);
  const result = {
    version: VERSION,
    runtime,
    platform,
    productSha256: createHash("sha256").update(await fs.readFile(modulePath))
      .digest("hex"),
    indexed: indexed.updated,
    unchanged: 3,
    fulltext: true,
    checks,
    embeddingDimensions: 768,
    ocrProvider: ocr.provider,
    transcriptionProvider: transcript.provider,
    transcriptOriginalLanguage: true,
  };
  await fs.writeFile(
    `build/results/release-smoke-${name}-${label}.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await rag.close();
}
