// Real OCR and Rag hook integration on public generated fixtures only.
import assert from "node:assert/strict";
import * as path from "node:path";
import { createHash } from "node:crypto";
import sharp from "npm:sharp@0.35.3";
import * as ort from "npm:onnxruntime-node@1.30.0";
import { Rag } from "../rag.js";
import { createIndra, INDRA, prepareIndra } from "./indra.js";

const root = path.resolve("build/indra-test");
await Deno.mkdir(root, { recursive: true });
const manifest = JSON.parse(
  await Deno.readTextFile("build/fixtures/manifest.json"),
);
const fixtures = manifest.filter((item) => item.image);
function normalize(text) {
  return Array.from(
    text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
  );
}
function cer(expected, actual) {
  const a = normalize(expected), b = normalize(actual);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
    }
    previous = current;
  }
  return previous[b.length] / Math.max(1, a.length);
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function textPdf(filename) {
  const sentence = fixtures[0].text.replaceAll("\n", " ");
  const stream =
    `BT /F1 12 Tf 20 740 Td (${sentence}) Tj 0 -20 Td (${sentence}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await Deno.writeTextFile(filename, pdf);
}

if (Deno.args[0] === "worker") {
  const provider = Deno.args[1];
  const setupStart = performance.now();
  const storageDir = Deno.args[2];
  const engine = provider === "paddle"
    ? null
    : await createIndra({ storageDir, provider });
  let calls = 0;
  const hook = engine
    ? async (request) => {
      calls++;
      return await engine.hook(request);
    }
    : undefined;
  const rag = await Rag.init({
    storageDir,
    rootDir: path.join(root, "inputs"),
    embedding: false,
    transcribe: false,
    ocr: hook ??
      { mode: "paddle", languages: "auto", acceleration: { provider: "cpu" } },
    hookVersion: { ocr: engine?.hook.version },
  });
  const setupMs = performance.now() - setupStart;
  const rows = [];
  const controls = {};
  try {
    for (let round = 0; round < 4; round++) {
      for (const fixture of fixtures) {
        const started = performance.now();
        const result = await rag.ocr(
          path.resolve("build/fixtures", fixture.image),
        );
        rows.push({
          id: fixture.id,
          round,
          ms: performance.now() - started,
          text: result.text,
          cer: cer(fixture.text, result.text),
          warnings: result.warnings,
        });
      }
    }
    if (engine) {
      // Rotation and blank image exercise actual orientation/detection inference.
      const rotated = await sharp("build/fixtures/en.png").rotate(270).png()
        .toBuffer();
      const rotatedResult = await rag.ocr({
        bytes: rotated,
        mime: "image/png",
      });
      assert.equal(cer(fixtures[0].text, rotatedResult.text), 0);
      controls.rotation270Cer = cer(fixtures[0].text, rotatedResult.text);
      const rotated90 = await sharp("build/fixtures/en.png").rotate(90).png()
        .toBuffer();
      const result90 = await rag.ocr({ bytes: rotated90, mime: "image/png" });
      controls.rotation90Cer = cer(fixtures[0].text, result90.text);
      controls.rotation90Applied = result90.metadata.rotation;
      const blank = await sharp({
        create: { width: 800, height: 800, channels: 3, background: "white" },
      }).png().toBuffer();
      assert.equal(
        (await rag.ocr({ bytes: blank, mime: "image/png" })).text.trim(),
        "",
      );
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(
        () =>
          rag.ocr(path.resolve("build/fixtures/en.png"), {
            signal: aborted.signal,
          }),
        { name: "AbortError" },
      );
      // Every supported script fixture has an accuracy bound; unsupported Arabic
      // is retained as a scored negative control, not counted as coverage.
      for (const row of rows.filter((item) => item.id !== "ar")) {
        assert.ok(row.cer < 0.15, `${row.id}: CER=${row.cer}`);
      }
    }
    // Warm engine; fresh storage on every invocation measures actual ingestion,
    // not an unchanged scan. Inputs are fixed public fixtures, never private data.
    await rag.addFolder(".");
    const started = performance.now();
    const indexed = await rag.index();
    assert.equal(indexed.failed, 0, JSON.stringify(indexed));
    assert.equal(indexed.skipped, 0);
    const ingestionMs = performance.now() - started;
    const search = await rag.search("library", {
      mode: "fulltext",
      refresh: "none",
      limit: 10,
    });
    assert.equal(
      new Set(
        search.hits.flatMap((hit) =>
          hit.citations.map((citation) => citation.path)
        ),
      ).size,
      3,
    );
    let pdfRouting;
    if (engine) {
      // Xberg must use the same hook for scanned PDFs, and skip it for text PDFs.
      const before = calls;
      const [document] = (await rag.listDocuments()).documents.filter((item) =>
        item.path === "document.pdf"
      );
      assert.ok(document);
      await rag.reindex({
        scope: { include: ["document.pdf"] },
        from: "extract",
      });
      assert.equal(calls, before);
      await rag.reindex({
        scope: { include: ["scanned.pdf"] },
        from: "extract",
      });
      assert.ok(calls > before);
      pdfRouting = { textPdfSkipsOcr: true, scannedPdfUsesHook: true };
    }
    const summary = {
      provider,
      setupMs,
      ingestionMs,
      documents: 3,
      retrievalPaths: 3,
      pdfRouting,
      controls,
      fixtures: fixtures.map((fixture) => {
        const samples = rows.filter((row) => row.id === fixture.id);
        return {
          id: fixture.id,
          coldMs: samples[0].ms,
          warmMedianMs: median(samples.slice(1).map((row) => row.ms)),
          cerNoWhitespace: samples.at(-1).cer,
        };
      }),
    };
    await Deno.writeTextFile(
      path.join(root, `${provider}.json`),
      JSON.stringify({ summary, rows }, null, 2),
    );
    console.log(JSON.stringify(summary));
  } finally {
    await rag.close();
    await engine?.close();
  }
} else {
  await Deno.mkdir(path.join(root, "inputs"), { recursive: true });
  await Deno.copyFile(
    "build/fixtures/en.png",
    path.join(root, "inputs/image.png"),
  );
  for (const name of ["document.pdf", "scanned.pdf"]) {
    await Deno.copyFile(
      `build/native-rag/input/${name}`,
      path.join(root, "inputs", name),
    );
  }
  await textPdf(path.join(root, "inputs/document.pdf"));
  // Never delete an old store. Each invocation gets fresh native record storage.
  const run = path.join(root, crypto.randomUUID());
  await Deno.mkdir(run, { recursive: true });
  const modelDirectory = await prepareIndra(path.join(root, "cpu"));
  const results = [];
  for (
    const provider of [
      "cpu",
      ...(Deno.build.os === "windows" ? ["dml"] : []),
      "paddle",
    ]
  ) {
    const store = path.join(run, provider);
    if (provider !== "paddle") {
      // Reuse immutable verified downloads, with distinct per-engine model paths.
      await Deno.mkdir(path.join(store, "models/indra", INDRA.revision), {
        recursive: true,
      });
      for (const name of Object.keys(INDRA.files)) {
        await Deno.copyFile(
          path.join(modelDirectory, name),
          path.join(store, "models/indra", INDRA.revision, name),
        );
      }
    }
    const process = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--node-modules-dir=auto",
        "-A",
        import.meta.filename,
        "worker",
        provider,
        store,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(process.stdout);
    const stderr = new TextDecoder().decode(process.stderr);
    await Deno.writeTextFile(
      path.join(root, `${provider}.log`),
      stdout + stderr,
    );
    assert.ok(process.success, `${provider}: ${stderr}\n${stdout}`);
    const summary = JSON.parse(stdout.trim().split("\n").at(-1));
    results.push(summary);
    console.log(JSON.stringify(summary));
  }
  let reference;
  try {
    const official = JSON.parse(
      await Deno.readTextFile(path.join(root, "python-reference.json")),
    );
    assert.equal(official.modelRevision, INDRA.revision);
    const cpu = JSON.parse(
      await Deno.readTextFile(path.join(root, "cpu.json")),
    );
    const scored = [];
    for (const fixture of fixtures) {
      const row = official.rows.find((item) => item.id === fixture.id);
      const imageHash = createHash("sha256").update(
        await Deno.readFile(path.resolve("build/fixtures", fixture.image)),
      ).digest("hex");
      assert.equal(
        row.imageSha256,
        imageHash,
        "Reference must use the same image bytes",
      );
      scored.push({
        id: row.id,
        coldMs: row.coldMs,
        warmMedianMs: row.warmMedianMs,
        cerNoWhitespace: cer(fixture.text, row.text),
        sameTextAsJs: row.text === cpu.rows.filter((item) =>
          item.id === row.id
        ).at(-1).text,
      });
    }
    reference = {
      python: official.python,
      indra: official.indra,
      onnxruntime: official.onnxruntime,
      setupMs: official.setupMs,
      fixtures: scored,
    };
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const report = {
    measuredAt: new Date().toISOString(),
    platform: Deno.build,
    runtime: Deno.version,
    productSha256: createHash("sha256").update(await Deno.readFile("rag.js"))
      .digest("hex"),
    dependencies: {
      ort: "1.30.0",
      sharp: "0.35.3",
      xberg: "1.3.10",
      turso: "0.8.3",
    },
    indra: INDRA,
    reference,
    experimentSha256: Object.fromEntries(
      await Promise.all(
        [
          "tests/indra.js",
          "tests/benchmark_indra.js",
          "tests/indra_reference.py",
        ].map(async (
          name,
        ) => [
          name,
          createHash("sha256").update(await Deno.readFile(name)).digest("hex"),
        ]),
      ),
    ),
    availableBackends: ort.listSupportedBackends(),
    notes: [
      "Public synthetic clean-print pages only; not OmniParseBench or the private 2.51GB corpus.",
      "Indra JS omits upstream deskew and learned layout/table/math assembly; these timings do not compare equivalent complete document pipelines.",
      "Warm OCR includes image decode, orientation, detection, script routing, recognition and JS processing. Setup/downloads are separate.",
      "Ingestion includes extraction, OCR, chunking, native FTS storage; embeddings disabled equally in every profile.",
      "Paddle uses the production unified auto profile, including the unsupported-script negative controls; Indra routes Chinese per line but does not detect language.",
      "DirectML requested successfully; ORT may assign unsupported/shape nodes to CPU. Not a claim of all-GPU execution.",
    ],
    results,
  };
  await Deno.writeTextFile(
    path.join(root, "results.json"),
    JSON.stringify(report, null, 2),
  );
}
