// Copied into an isolated consumer directory by release_package.js.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Rag, VERSION } from "@mefistofelix/rag.js";

const entry = fileURLToPath(import.meta.resolve("@mefistofelix/rag.js"));
assert.equal(entry, path.resolve("node_modules/@mefistofelix/rag.js/rag.js"));
await fs.mkdir("docs", { recursive: true });
try {
  await fs.writeFile(
    "docs/science.txt",
    "The library stores astronomy manuscripts.",
    { flag: "wx" },
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
const rag = await Rag.init({
  storageDir: "storage",
  embedding: false,
  ocr: false,
  transcribe: false,
});
try {
  await rag.addFolder("docs");
  const indexed = await rag.index();
  const result = await rag.search("astronomy", {
    mode: "fulltext",
    refresh: "none",
  });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].citations[0].relativePath, "docs/science.txt");
  console.log(JSON.stringify({
    version: VERSION,
    runtime: globalThis.Bun ? { bun: Bun.version } : Deno.version,
    productSha256: createHash("sha256").update(await fs.readFile(entry)).digest(
      "hex",
    ),
    updated: indexed.updated,
    unchanged: indexed.unchanged,
    bareImport: true,
    fulltext: true,
  }));
} finally {
  await rag.close();
}
