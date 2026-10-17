// Generate a private local selection from completed downloads, without logging names.
import * as path from "node:path";

const pdfCount = Number(Deno.args[0] ?? 12);
const audioCount = Number(Deno.args[1] ?? 2);
const completed = new Map();
for await (const entry of Deno.readDir("build/corpora/queues")) {
  if (!entry.name.endsWith(".result.json")) continue;
  const rows = JSON.parse(
    await Deno.readTextFile(path.join("build/corpora/queues", entry.name)),
  );
  for (const row of rows) if (row.ok) completed.set(row.id, row);
}
const candidates = [...completed.values()].filter((item) =>
  !/[\[\]{}*?!]/.test(item.path) && item.bytes <= 500_000
)
  .sort((a, b) => a.bytes - b.bytes || a.path.localeCompare(b.path));
async function selectUnique(pattern, count) {
  const selected = [];
  const hashes = new Set();
  for (const item of candidates.filter((item) => pattern.test(item.path))) {
    if (selected.length >= count) break;
    const bytes = await Deno.readFile(path.resolve("build/corpora", item.path));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
      .join(",");
    if (hashes.has(digest)) continue;
    hashes.add(digest);
    selected.push(item);
  }
  return selected;
}
const selection = [
  ...await selectUnique(/\.pdf$/i, pdfCount),
  ...await selectUnique(/\.(aac|m4a)$/i, audioCount),
];
if (selection.length !== pdfCount + audioCount) {
  throw new Error(
    "Not enough completed local downloads for the requested selection",
  );
}
await Deno.writeTextFile(
  "build/corpora/smoke-selection.json",
  JSON.stringify(selection, null, 2),
);
console.log(
  JSON.stringify({
    pdf: pdfCount,
    audio: audioCount,
    bytes: selection.reduce((sum, item) => sum + item.bytes, 0),
  }),
);
