import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { VERSION } from "../rag.js";

const read = async (name) =>
  JSON.parse(await fs.readFile(`build/results/${name}.json`, "utf8"));
const source = await fs.readFile("rag.js");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const core = {
  deno: await read("core-contracts-v2"),
  bun: await read("core-contracts-bun"),
};
const native = {
  deno: (await read("rag-native-v2-default"))[0],
  bun: (await read("rag-native-bun-default"))[0],
};
const archives = {
  deno: (await read("rag-archives-v2"))[0],
  bun: (await read("rag-archives-bun"))[0],
};
const multilingual = {
  deno: await read("release-smoke-deno-source"),
  bun: await read("release-smoke-bun-source"),
};
const packaged = await read("release-package");
for (const group of [core, native, archives, multilingual]) {
  for (const row of Object.values(group)) {
    assert.equal(row.productSha256, sourceSha256);
  }
}
for (const row of Object.values(core)) {
  assert.equal(row.passed, 28);
  assert.equal(row.failed, 0);
}
assert.deepEqual(multilingual.deno.checks, multilingual.bun.checks);
assert.equal(packaged.productSha256, sourceSha256);
assert.equal(packaged.crossRuntimePersistence, true);
const archive = await fs.readFile(
  "build/release/mefistofelix-rag.js-0.3.0.tgz",
);
assert.equal(
  createHash("sha256").update(archive).digest("hex"),
  packaged.archiveSha256,
);
const manifest = JSON.parse(await fs.readFile("package.json", "utf8"));
assert.equal(manifest.version, VERSION);
await fs.writeFile(
  "reports/release-v0.3.0.json",
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      version: VERSION,
      package: manifest.name,
      license: manifest.license,
      sourceSha256,
      sourceBytes: source.length,
      tarball: {
        bytes: archive.length,
        integrity: "sha512-" +
          createHash("sha512").update(archive).digest("base64"),
        sha256: packaged.archiveSha256,
        files: packaged.files,
      },
      core,
      native,
      archives,
      multilingual,
      packagedConsumers: packaged.rows,
      crossRuntimePersistence: true,
      limitations: [
        "Execution verified on Windows x64 only; other target platforms remain unexecuted.",
        "CPU native inference; no new GPU performance claim.",
        "Three multilingual vector queries and independent RRF checks are smoke tests, not full-corpus relevance evaluation.",
        "The private 2.5 GB corpus and experimental OCR/embedding providers were not rerun for this release.",
      ],
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    version: VERSION,
    sourceSha256,
    corePassed: { deno: 28, bun: 28 },
    packaged: true,
  }),
);
