import * as path from "node:path";

const directory = path.resolve("build/corpora");
const queuePath = Deno.args[0] ?? "build/corpora/download-queue.json";
const queue = JSON.parse(await Deno.readTextFile(queuePath));
const results = [];
async function materialize(item) {
  const parts = item.path.split("/").map((part) => {
    const safe = part.replace(/[<>:"\\|?*\p{Cc}]/gu, "_").replace(
      /[. ]+$/,
      "",
    );
    if (!safe || safe === "." || safe === "..") {
      throw new Error("Invalid corpus path component");
    }
    return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)
      ? `_${safe}`
      : safe;
  });
  const filename = path.resolve(directory, ...parts);
  if (!filename.startsWith(directory + path.sep)) {
    throw new Error("Corpus path escaped its directory");
  }
  await Deno.mkdir(path.dirname(filename), { recursive: true });
  try {
    const response = await fetch(item.downloadUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const file = await Deno.open(filename + ".part", {
      create: true,
      truncate: true,
      write: true,
    });
    await response.body.pipeTo(file.writable);
    const stat = await Deno.stat(filename + ".part");
    if (item.expectedBytes && stat.size !== item.expectedBytes) {
      throw new Error("Downloaded byte count differs from Drive metadata");
    }
    await Deno.rename(filename + ".part", filename);
    results.push({
      id: item.id,
      path: path.relative(directory, filename),
      bytes: stat.size,
      ok: true,
    });
  } catch (error) {
    results.push({
      id: item.id,
      path: path.relative(directory, filename),
      ok: false,
      error: String(error),
    });
  }
}
for (let start = 0; start < queue.length; start += 6) {
  await Promise.all(queue.slice(start, start + 6).map(materialize));
}
await Deno.writeTextFile(
  queuePath + ".result.json",
  JSON.stringify(results, null, 2),
);
console.log(
  JSON.stringify({
    downloaded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
  }),
);
if (results.some((item) => !item.ok)) Deno.exitCode = 1;
