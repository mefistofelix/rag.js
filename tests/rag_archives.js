import assert from "node:assert/strict";
import * as path from "node:path";
import {
  command,
  fs,
  name as runtimeName,
  platform,
  runtime,
} from "./test_runtime.js";
import { createHash } from "node:crypto";
import { Rag, VERSION } from "../rag.js";

const productSha256 = createHash("sha256").update(await fs.readFile("rag.js"))
  .digest("hex");

const root = path.resolve("build/ar", crypto.randomUUID().slice(0, 8));
for (const directory of ["input/a", "input/b", "inner/deep", "source"]) {
  await fs.mkdir(path.join(root, directory), { recursive: true });
}
const repeated = "The library stores rare astronomy manuscripts.";
await fs.writeFile(path.join(root, "input/a/one.txt"), repeated);
await fs.writeFile(path.join(root, "input/b/two.txt"), repeated);
await fs.writeFile(
  path.join(root, "inner/deep/note.txt"),
  "The oceanography expedition studies coral reefs.",
);
async function zip(input, destination) {
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const result = await command("powershell.exe", {
    args: [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      `[IO.Compression.ZipFile]::CreateFromDirectory(${
        quote(path.join(root, input))
      }, ${quote(path.join(root, destination))})`,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  assert.ok(result.success, new TextDecoder().decode(result.stderr));
}
await zip("inner", "input/inside.zip");
await zip("input", "source/fixture.zip");
const rows = [];
for (const driver of ["turso"]) {
  const config = {
    rootDir: root,
    storageDir: path.join(root, "t"),
    storage: { driver },
    embedding: false,
    ocr: false,
    transcribe: false,
  };
  let rag = await Rag.init(config);
  try {
    await rag.addFolder("source");
    const indexed = await rag.index();
    assert.equal(indexed.failed, 0, JSON.stringify(indexed));
    assert.equal(indexed.updated, 1);
    const same = await rag.search("astronomy", { mode: "fulltext" });
    assert.equal(same.hits.length, 1);
    assert.equal(same.hits[0].text, repeated);
    assert.deepEqual(
      same.hits[0].citations.map((citation) =>
        citation.locator.entries.map((entry) => entry.replaceAll("\\", "/"))
      ).sort(),
      [["a/one.txt"], ["b/two.txt"]],
    );
    const nested = await rag.search("oceanography", { mode: "fulltext" });
    assert.equal(nested.hits.length, 1);
    assert.deepEqual(
      nested.hits[0].citations[0].locator.entries.map((entry) =>
        entry.replaceAll("\\", "/")
      ),
      [
        "inside.zip",
        "deep/note.txt",
      ],
    );
    assert.equal((await rag.status()).counts.chunks, 2);
    await rag.close();
    rag = await Rag.init(config);
    await rag.addFolder("source");
    assert.equal((await rag.index()).unchanged, 1);
    assert.equal(
      (await rag.search("astronomy", { mode: "fulltext" })).hits[0].citations
        .length,
      2,
    );
    rows.push({
      driver,
      productVersion: VERSION,
      productSha256,
      platform: platform,
      runtime: runtime,
      nestedEntryProvenance: true,
      duplicateOccurrences: 2,
      uniqueChunks: 2,
      persisted: true,
    });
  } finally {
    await rag.close();
  }
  const limited = await Rag.init({
    ...config,
    indexing: { maxArchiveEntries: 1 },
  });
  try {
    await limited.addFolder("source");
    const report = await limited.index();
    assert.equal(report.failed + report.skipped, 1, JSON.stringify(report));
    assert.equal(
      (await limited.search("astronomy", { mode: "fulltext", refresh: "none" }))
        .hits.length,
      1,
    );
    rows.at(-1).entryLimitRejected = true;
  } finally {
    await limited.close();
  }
}
await fs.mkdir("build/results", { recursive: true });
await fs.writeFile(
  `build/results/rag-archives-${runtimeName === "deno" ? "v2" : "bun"}.json`,
  JSON.stringify(rows, null, 2),
);
console.log(JSON.stringify(rows));
