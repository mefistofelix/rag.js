import * as path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const resultsDirectory = path.join(root, "build/results");
const fixturesDirectory = path.join(root, "build/fixtures");
const readJson = async (name) =>
  JSON.parse(await Deno.readTextFile(path.join(resultsDirectory, name)));
const audit = await readJson("dependency-audit.json");
const probe = await readJson("probe.json");
const manifest = JSON.parse(
  await Deno.readTextFile(path.join(fixturesDirectory, "manifest.json")),
);

function normalizedCharacters(text) {
  return Array.from(
    text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
  );
}

// Separate from the original experiment metric: ignore all whitespace, so
// inserting spaces between Chinese characters does not become a text error.
function cerNoWhitespace(expected, actual) {
  const a = normalizedCharacters(expected);
  const b = normalizedCharacters(actual);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] / Math.max(1, a.length);
}

function sanitize(value) {
  if (typeof value === "string") {
    return value.replaceAll(root, "<workspace>")
      .replaceAll(root.replaceAll("\\", "/"), "<workspace>");
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitize(item)]),
    );
  }
  return value;
}

async function fileHashes(directory, relative = "") {
  const files = [];
  for await (const entry of Deno.readDir(path.join(directory, relative))) {
    const filename = path.join(relative, entry.name);
    if (entry.isDirectory) {
      files.push(...await fileHashes(directory, filename));
    } else if (entry.isFile && !entry.name.endsWith(".part")) {
      const hash = createHash("sha256");
      const file = await Deno.open(path.join(directory, filename));
      for await (const bytes of file.readable) hash.update(bytes);
      files.push({
        path: filename.replaceAll("\\", "/"),
        sha256: hash.digest("hex"),
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const experiments = [];
const filenames = [];
for await (const entry of Deno.readDir(resultsDirectory)) {
  if (/^(ocr|asr)-.*\.json$/.test(entry.name)) filenames.push(entry.name);
}
for (const filename of filenames.sort()) {
  const experiment = await readJson(filename);
  for (const row of experiment.rows) {
    const fixtureId = experiment.stage.startsWith("asr-")
      ? `speech-${row.id.split("-")[0]}`
      : row.id;
    const fixture = manifest.find((item) => item.id === fixtureId);
    if (!fixture) throw new Error(`Missing reference: ${filename}/${row.id}`);
    row.expected = fixture.text;
    if (row.ok) row.cerNoWhitespace = cerNoWhitespace(fixture.text, row.text);
  }
  experiments.push(experiment);
}

const date = audit.checkedAt.slice(0, 10);
const target = `${Deno.build.os}-${
  Deno.build.arch === "x86_64" ? "x64" : Deno.build.arch
}`;
const basename = `${target}-${date}`;
const report = sanitize({
  recordedAt: new Date().toISOString(),
  dependencyAuditAt: audit.checkedAt,
  environment: { deno: probe.deno, target: probe.target },
  limitations: [
    "Only Windows x64 executed; other targets checked for published npm binaries.",
    "ok means no exception, not correct recognition. Expected failures are retained.",
    "Tiny smoke fixtures, not a quality benchmark or a calibrated language detector.",
    "CER strips punctuation and folds case; cer retains whitespace, cerNoWhitespace removes it.",
    "Numbers such as twenty versus 20 remain different; timings include initialization and are not comparative benchmarks.",
    "GGML tiny and Sherpa ONNX tiny conversions/precision differ; no quality ranking between wrappers follows.",
  ],
  nativeOcr: await readJson("windows-native-info.json"),
  globCapabilities: await readJson("glob-standard.json"),
  xbergCapabilities: await readJson("xberg-capabilities.json"),
  imports: probe.results.map((item) => ({
    ...item,
    exports: item.exports?.filter((name) =>
      /whisper|transcri|ocr|extract|embed|language|context/i.test(name)
    ),
  })),
  dependencies: audit.results,
  fixtures: manifest,
  fixtureHashes: await fileHashes(fixturesDirectory),
  modelHashes: await fileHashes(path.join(root, "build/models")),
  counts: {
    experiments: experiments.length,
    cases: experiments.reduce((total, item) => total + item.rows.length, 0),
    completedWithoutException: experiments.reduce(
      (total, item) => total + item.rows.filter((row) => row.ok).length,
      0,
    ),
  },
  experiments,
});

await Deno.mkdir(path.join(root, "reports"), { recursive: true });
await Deno.writeTextFile(
  path.join(root, "reports", basename + ".json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({ report: "reports/" + basename + ".json", ...report.counts }),
);
