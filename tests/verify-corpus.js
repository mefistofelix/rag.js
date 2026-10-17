// Verify local checkpoints against Drive metadata; do not log private identities.
import * as path from "node:path";

const root = path.resolve("build/corpora");
const inventory = JSON.parse(
  await Deno.readTextFile(path.join(root, "inventory.json")),
);
const completed = new Map();
for await (const entry of Deno.readDir(path.join(root, "queues"))) {
  if (!entry.name.endsWith(".result.json")) continue;
  const rows = JSON.parse(
    await Deno.readTextFile(path.join(root, "queues", entry.name)),
  );
  for (const row of rows) if (row.ok) completed.set(row.id, row);
}
const failures = [];
let bytes = 0;
let nativePdfExports = 0;
for (const expected of inventory) {
  const local = completed.get(expected.id);
  if (!local) {
    failures.push({ id: expected.id, reason: "missing" });
    continue;
  }
  const filename = path.resolve(root, local.path);
  const relative = path.relative(root, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Checkpoint path escaped corpus root");
  }
  try {
    const stat = await Deno.stat(filename);
    const native = expected.mime.startsWith("application/vnd.google-apps.");
    if (
      stat.size !== local.bytes ||
      (!native && expected.size && stat.size !== Number(expected.size))
    ) {
      failures.push({ id: expected.id, reason: "size" });
      continue;
    }
    if (native) {
      const file = await Deno.open(filename);
      const header = new Uint8Array(5);
      try {
        await file.read(header);
      } finally {
        file.close();
      }
      if (new TextDecoder().decode(header) !== "%PDF-") {
        failures.push({ id: expected.id, reason: "export-format" });
        continue;
      }
      nativePdfExports++;
    }
    bytes += stat.size;
  } catch (error) {
    failures.push({ id: expected.id, reason: error.name });
  }
}
let partialFiles = 0;
async function scan(directory) {
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isDirectory) await scan(path.join(directory, entry.name));
    else if (entry.name.endsWith(".part")) partialFiles++;
  }
}
await scan(root);
const summary = {
  expected: inventory.length,
  verified: inventory.length - failures.length,
  bytes,
  nativePdfExports,
  partialFiles,
  failures,
  time: new Date().toISOString(),
};
await Deno.writeTextFile(
  path.join(root, "verification.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ ...summary, failures: failures.length }));
if (failures.length || partialFiles) Deno.exitCode = 1;
