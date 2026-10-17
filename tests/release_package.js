import assert from "node:assert/strict";
import * as path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const archive = path.resolve("build/release/mefistofelix-rag.js-0.3.0.tgz");
const consumer = await fs.mkdtemp(path.join(root, "build/release/consumer-"));
const installed = path.join(consumer, "node_modules/@mefistofelix/rag.js");
await fs.mkdir(installed, { recursive: true });
async function command(executable, args) {
  const result = await new Deno.Command(executable, {
    args,
    cwd: consumer,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}
const files = (await command("tar.exe", ["-tf", archive])).trim().split(/\r?\n/)
  .sort();
assert.deepEqual(files, [
  "package/LICENSE",
  "package/README.md",
  "package/package.json",
  "package/rag.js",
]);
await command("tar.exe", [
  "-xf",
  archive,
  "-C",
  installed,
  "--strip-components=1",
]);
await fs.copyFile(
  "tests/package_consumer.js",
  path.join(consumer, "consumer.js"),
);
await fs.writeFile(
  path.join(consumer, "package.json"),
  JSON.stringify({
    name: "rag-package-consumer-test",
    type: "module",
    dependencies: {
      "@mefistofelix/rag.js": "file:" + archive.replaceAll("\\", "/"),
    },
  }),
);
await command(path.join(root, "tools/bun/bun-windows-x64/bun.exe"), [
  "install",
  "--ignore-scripts",
]);
const sourceSha256 = createHash("sha256").update(await fs.readFile("rag.js"))
  .digest("hex");
const rows = [];
for (
  const [executable, args] of [
    [Deno.execPath(), [
      "run",
      "--no-config",
      "--node-modules-dir=manual",
      "-A",
      "consumer.js",
    ]],
    [path.join(root, "tools/bun/bun-windows-x64/bun.exe"), [
      "run",
      "consumer.js",
    ]],
  ]
) {
  const row = JSON.parse((await command(executable, args)).trim());
  assert.equal(row.productSha256, sourceSha256);
  assert.equal(row.updated, rows.length ? 0 : 1);
  assert.equal(row.unchanged, rows.length ? 1 : 0);
  rows.push(row);
}
await fs.writeFile(
  "build/results/release-package.json",
  JSON.stringify(
    {
      files,
      archiveSha256: createHash("sha256").update(await fs.readFile(archive))
        .digest("hex"),
      productSha256: sourceSha256,
      rows,
      crossRuntimePersistence: true,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ files, rows, crossRuntimePersistence: true }));
