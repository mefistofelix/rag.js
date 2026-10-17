// Reproduce the website's pinned input selection, not its hardware or scorer.
import assert from "node:assert/strict";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Rag } from "../rag.js";

const xbergRevision = "55504146733df3135caa434eac3622266db2e931";
// The website's old submodule a0cf3cbe is no longer downloadable (HTTP 404/422).
// Keep the same descriptors, but identify the available corpus revision honestly.
const corpusRevision = "bfd2dc2d1d333cc6a69f28e55cdb2d9485f2e175";
const directory = path.resolve("build/xc");
await Deno.mkdir(directory, { recursive: true });
const mode = Deno.args[0] ?? "prepare";
const json = async (filename) => JSON.parse(await Deno.readTextFile(filename));
const save = (filename, value) =>
  Deno.writeTextFile(filename, JSON.stringify(value, null, 2));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function download(url, filename) {
  await Deno.mkdir(path.dirname(filename), { recursive: true });
  const result = await new Deno.Command("curl.exe", {
    args: ["-L", "--fail", "--silent", "--show-error", url, "-o", filename],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(
    result.success,
    `${url}: ${new TextDecoder().decode(result.stderr)}`,
  );
}

async function raw(repository, revision, name, filename) {
  await download(
    `https://raw.githubusercontent.com/xberg-io/${repository}/${revision}/${name}`,
    filename,
  );
  return filename;
}

if (mode === "prepare") {
  const fixtureNames = new Set();
  for (
    const cohort of [
      "native-pdf-fast-b8",
      "ocr-pdf-fast-b4",
      "native-office-fast",
      "native-markup-fast",
      "native-ebook-fast",
      "native-email-fast",
      "native-data-fast",
      "ocr-images-fast",
    ]
  ) {
    const filename = await raw(
      "xberg",
      xbergRevision,
      `tools/benchmark-harness/cohorts/${cohort}.json`,
      path.join(directory, "cohorts", `${cohort}.json`),
    );
    for (const fixture of (await json(filename)).fixtures) {
      fixtureNames.add(fixture);
    }
  }
  const websiteCount = fixtureNames.size;
  assert.equal(websiteCount, 60);
  const websiteNames = new Set(fixtureNames);
  for (
    const name of [
      "7z_archive",
      "tar_archive",
      "tgz_archive",
      "zip_archive",
      "gz_compressed",
    ]
  ) {
    fixtureNames.add(`${name}.json`);
  }
  const lock = await json(
    await raw(
      "test_documents",
      corpusRevision,
      "corpus.lock.json",
      path.join(directory, "corpus.lock.json"),
    ),
  );
  const corpusManifest = await json(
    await raw(
      "test_documents",
      corpusRevision,
      "ground_truth/corpus_manifest.json",
      path.join(directory, "corpus-manifest.json"),
    ),
  );
  let parsebench;
  const fixtures = [];
  for (const name of fixtureNames) {
    try {
      const descriptorFile = await raw(
        "xberg",
        xbergRevision,
        `tools/benchmark-harness/fixtures/${name}`,
        path.join(directory, "descriptors", name),
      );
      const descriptor = await json(descriptorFile);
      const resolve = (reference) => {
        // Descriptor paths are relative to the upstream fixtures directory.
        const canonical = path.posix.normalize(
          path.posix.join(
            "tools/benchmark-harness/fixtures",
            path.posix.dirname(name),
            reference,
          ),
        );
        assert.ok(canonical.startsWith("test_documents/"), canonical);
        return canonical.slice("test_documents/".length);
      };
      const document = resolve(descriptor.document);
      const filename = path.join(directory, "documents", document);
      const object = lock.objects[document];
      await Deno.mkdir(path.dirname(filename), { recursive: true });
      if (object) {
        let valid = false;
        try {
          valid = digest(await Deno.readFile(filename)) === object.sha256;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        if (!valid) {
          await download(
            `https://storage.googleapis.com/xberg-test-documents/objects/${object.sha256}`,
            filename,
          );
        }
        assert.equal(
          digest(await Deno.readFile(filename)),
          object.sha256,
          document,
        );
      } else if (
        document.startsWith(".corpus-cache/pdf/") &&
        descriptor.metadata?.source === "parsebench"
      ) {
        const id = path.posix.basename(document, ".pdf");
        const provenance = corpusManifest.documents.find((item) =>
          item.id === id
        );
        assert.ok(provenance?.pdf_sha256 && provenance.source_revision);
        const base =
          `https://huggingface.co/datasets/llamaindex/ParseBench/resolve/${provenance.source_revision}/`;
        if (!parsebench) {
          const tableFile = path.join(directory, "parsebench-table.jsonl");
          await download(base + "table.jsonl", tableFile);
          parsebench = (await Deno.readTextFile(tableFile)).trim().split("\n")
            .map((line) => JSON.parse(line));
        }
        const reference = parsebench.find((item) =>
          `pb_${
            path.posix.basename(item.pdf, ".pdf").replace(
              /[^A-Za-z0-9._-]+/g,
              "_",
            )
          }` === id
        );
        assert.ok(reference, id);
        await download(
          base + reference.pdf.split("/").map(encodeURIComponent).join("/"),
          filename,
        );
        assert.equal(
          digest(await Deno.readFile(filename)),
          provenance.pdf_sha256,
        );
      } else await raw("test_documents", corpusRevision, document, filename);
      let groundTruth;
      if (
        descriptor.ground_truth?.text_file &&
        !document.startsWith(".corpus-cache/")
      ) {
        const reference = resolve(descriptor.ground_truth.text_file);
        groundTruth = await raw(
          "test_documents",
          corpusRevision,
          reference,
          path.join(directory, "references", reference),
        );
      }
      fixtures.push({
        descriptor: name,
        document,
        filename,
        groundTruth,
        website: websiteNames.has(name),
        type: descriptor.file_type,
        sha256: digest(await Deno.readFile(filename)),
        bytes: (await Deno.stat(filename)).size,
        descriptorBytes: descriptor.file_size,
      });
    } catch (error) {
      if (
        !error.message.includes("(22) The requested URL returned error: 404")
      ) throw error;
      fixtures.push({
        descriptor: name,
        website: websiteNames.has(name),
        unavailable: error.message,
      });
    }
    console.log(
      JSON.stringify({ prepared: fixtures.length, total: fixtureNames.size }),
    );
  }
  await save(path.join(directory, "manifest.json"), {
    xbergRevision,
    corpusRevision,
    websiteCount,
    fixtures,
  });
} else if (mode === "run") {
  const manifest = await json(path.join(directory, "manifest.json"));
  const storageDir = path.join(
    directory,
    "runs",
    crypto.randomUUID().slice(0, 6),
  );
  const copyTree = async (source, destination) => {
    await Deno.mkdir(destination, { recursive: true });
    for await (const item of Deno.readDir(source)) {
      const from = path.join(source, item.name),
        to = path.join(destination, item.name);
      if (item.isDirectory) await copyTree(from, to);
      else if (item.isFile) await Deno.copyFile(from, to);
    }
  };
  const setupStart = performance.now();
  await copyTree(
    path.resolve("build/ocr-comparison/paddle/models/paddle"),
    path.join(storageDir, "models/paddle"),
  );
  const setupMs = performance.now() - setupStart;
  let ocrCalls = 0;
  const rag = await Rag.init({
    storageDir,
    rootDir: path.join(directory, "documents"),
    embedding: false,
    transcribe: false,
    ocr: async (request, next) => {
      ocrCalls++;
      return await next(request);
    },
    hookVersion: { ocr: "corpus-observer-v1" },
    indexing: { maxPages: 10000 },
  });
  const tokenCounts = (text) => {
    const counts = new Map();
    for (
      const token
        of text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
    ) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
  };
  const tokenF1 = (actual, expected) => {
    const a = tokenCounts(actual), b = tokenCounts(expected);
    const count = (map) => [...map.values()].reduce((sum, n) => sum + n, 0);
    const overlap = [...a].reduce(
      (sum, [token, n]) => sum + Math.min(n, b.get(token) ?? 0),
      0,
    );
    return count(a) + count(b) ? 2 * overlap / (count(a) + count(b)) : 1;
  };
  const rows = [];
  try {
    for (const fixture of manifest.fixtures) {
      if (fixture.unavailable) {
        rows.push(fixture);
        continue;
      }
      const beforeOcr = ocrCalls;
      const start = performance.now();
      let row;
      try {
        const extracted = await rag._providers.extract({
          input: {
            path: fixture.filename,
            filename: path.basename(fixture.filename),
          },
        });
        const text = extracted.units.map((unit) => unit.text).join("\n");
        row = {
          mime: extracted.mime,
          units: extracted.units.length,
          characters: text.length,
          metadataKeys: [
            ...new Set(
              extracted.units.flatMap((unit) =>
                Object.keys(unit.locator?.metadata ?? {})
              ),
            ),
          ],
          archiveEntries: [
            ...new Set(
              extracted.units.filter((unit) => unit.locator?.entries).map((
                unit,
              ) => JSON.stringify(unit.locator.entries)),
            ),
          ].length,
          warnings: extracted.warnings,
          tokenF1: fixture.groundTruth
            ? tokenF1(text, await Deno.readTextFile(fixture.groundTruth))
            : undefined,
        };
      } catch (error) {
        row = { error: { code: error.code, message: error.message } };
      }
      rows.push({
        ...fixture,
        ...row,
        ms: performance.now() - start,
        ocrCalls: ocrCalls - beforeOcr,
      });
      await save(path.join(directory, "results.json"), {
        target: `${Deno.build.os}/${Deno.build.arch}`,
        deno: Deno.version.deno,
        xberg: "1.3.10",
        xbergRevision,
        corpusRevision,
        measuredAt: new Date().toISOString(),
        websiteCount: manifest.websiteCount,
        configuration: { ocr: "PaddleOCR v6 small auto", embeddings: false },
        sourceSha256: digest(await Deno.readFile("rag.js")),
        setupMs,
        modelFilesPreseeded: true,
        rows,
      });
      console.log(
        JSON.stringify({
          completed: rows.length,
          total: manifest.fixtures.length,
          type: fixture.type,
          ms: rows.at(-1).ms,
          ocrCalls: rows.at(-1).ocrCalls,
          error: row.error?.code,
        }),
      );
    }
  } finally {
    await rag.close();
  }
} else throw new Error("Use prepare or run");
