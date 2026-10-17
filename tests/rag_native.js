import assert from "node:assert/strict";
import * as path from "node:path";
import {
  args,
  command,
  fs,
  name as runtimeName,
  platform,
  runtime,
  temporaryDirectory,
} from "./test_runtime.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Rag, VERSION } from "../rag.js";

const productSha256 = createHash("sha256").update(await fs.readFile("rag.js"))
  .digest("hex");

const directory = path.resolve("build/native-rag");
const ocrMode = args[0] ?? "default";
assert.ok(["default", "tesseract", "paddle"].includes(ocrMode));
await fs.mkdir(path.join(directory, "input"), { recursive: true });
const video = path.join(directory, "input/fixture.mp4");
const ffmpeg = await command(path.resolve("tools/ffmpeg.exe"), {
  args: [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-i",
    "build/fixtures/en.png",
    "-i",
    "build/fixtures/speech-en.wav",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-r",
    "2",
    "-c:a",
    "aac",
    "-pix_fmt",
    "yuv420p",
    "-shortest",
    video,
  ],
  stdout: "piped",
  stderr: "piped",
});
if (!ffmpeg.success) throw new Error(new TextDecoder().decode(ffmpeg.stderr));
const rawDirectory = path.join(directory, "raw");
await fs.mkdir(rawDirectory, { recursive: true });
const rawVideo = path.join(rawDirectory, "fixture.m2v");
const elementary = await command(path.resolve("tools/ffmpeg.exe"), {
  args: [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    video,
    "-an",
    "-c:v",
    "mpeg2video",
    "-f",
    "mpeg2video",
    rawVideo,
  ],
  stdout: "piped",
  stderr: "piped",
});
assert.ok(elementary.success);

// One page PDF with a real text layer, generated without another dependency.
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
const stream =
  "BT /F1 18 Tf 50 700 Td (Library science contract document) Tj ET\n";
objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = pdf.length;
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
for (const offset of offsets.slice(1)) {
  pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
}
pdf +=
  `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await fs.writeFile(path.join(directory, "input/document.pdf"), pdf);

// Image-only PDF exercises the registered OCR backend, unlike a text-layer PDF.
const jpegPath = path.join(directory, "scan.jpg");
const jpeg = await command(path.resolve("tools/ffmpeg.exe"), {
  args: [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    "build/fixtures/en.png",
    "-frames:v",
    "1",
    jpegPath,
  ],
  stdout: "piped",
  stderr: "piped",
});
assert.ok(jpeg.success);
const imageBytes = Buffer.from(await fs.readFile(jpegPath)).toString(
  "latin1",
);
const imageStream = "q 540 0 0 148 36 500 cm /Im1 Do Q\n";
const scanObjects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
  `<< /Type /XObject /Subtype /Image /Width 2000 /Height 550 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n${imageBytes}\nendstream`,
  `<< /Length ${imageStream.length} >>\nstream\n${imageStream}endstream`,
];
let scannedPdf = "%PDF-1.4\n";
const scanOffsets = [0];
for (const [index, object] of scanObjects.entries()) {
  scanOffsets.push(scannedPdf.length);
  scannedPdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const scanXref = scannedPdf.length;
scannedPdf += `xref\n0 ${scanOffsets.length}\n0000000000 65535 f \n`;
for (const offset of scanOffsets.slice(1)) {
  scannedPdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
}
scannedPdf +=
  `trailer\n<< /Size ${scanOffsets.length} /Root 1 0 R >>\nstartxref\n${scanXref}\n%%EOF\n`;
await fs.writeFile(
  path.join(directory, "input/scanned.pdf"),
  Buffer.from(scannedPdf, "latin1"),
);

const results = [];
for (const driver of ["turso"]) {
  const storageDir = await temporaryDirectory({
    dir: directory,
    prefix: `${driver}-`,
  });
  await fs.mkdir(path.join(storageDir, "models/tessdata"), {
    recursive: true,
  });
  try {
    await fs.copyFile(
      "build/models/tessdata/eng.traineddata",
      path.join(storageDir, "models/tessdata/eng.traineddata"),
    );
  } catch (error) {
    if (!(error.code === "ENOENT")) throw error;
  }
  let modelPath;
  try {
    await fs.stat("build/models/whisper/ggml-tiny.bin");
    modelPath = path.resolve("build/models/whisper/ggml-tiny.bin");
  } catch (error) {
    if (!(error.code === "ENOENT")) throw error;
  }
  const config = {
    rootDir: directory,
    storageDir,
    storage: { driver },
    embedding: false,
    ocr: ocrMode === "default"
      ? undefined
      : { mode: ocrMode, languages: ["eng"] },
    transcribe: { modelPath },
    indexing: { video: { ocr: { intervalSeconds: 4, maxFrames: 3 } } },
  };
  const rag = await Rag.init(config);
  try {
    await rag.addFolder("input");
    let started = performance.now();
    const report = await rag.index();
    const indexMs = performance.now() - started;
    started = performance.now();
    const unchanged = await rag.index();
    const unchangedMs = performance.now() - started;
    assert.equal(unchanged.updated, 0);
    assert.equal(report.failed, 0, JSON.stringify(report.errors));
    assert.equal(report.updated, 3, JSON.stringify(report));
    const found = await rag.search("library", { mode: "fulltext" });
    assert.ok(found.hits.length > 0);
    const citations = found.hits.flatMap((hit) => hit.citations);
    assert.ok(
      citations.some((citation) => citation.locator.channel === "video-ocr"),
      "video frame OCR is searchable",
    );
    assert.ok(
      citations.some((citation) => citation.locator.channel === "audio"),
      "video audio is searchable",
    );
    assert.ok(
      citations.some((citation) =>
        citation.mime === "application/pdf" && citation.locator.page === 1
      ),
    );
    assert.ok(
      citations.some((citation) => citation.path.endsWith("scanned.pdf")),
    );
    started = performance.now();
    const transcript = await rag.transcribe("input/fixture.mp4");
    const transcribeVideoMs = performance.now() - started;
    assert.match(transcript.text.toLowerCase(), /library/);
    const bytes = await fs.readFile("build/fixtures/speech-en.m4a");
    assert.match(
      (await rag.transcribe({ bytes, mime: "audio/mp4", filename: "clip.m4a" }))
        .text.toLowerCase(),
      /library/,
    );
    started = performance.now();
    const image = await rag.ocr(path.resolve("build/fixtures/en.png"));
    const ocrImageMs = performance.now() - started;
    assert.match(image.text.toLowerCase(), /library/);
    if (ocrMode === "default") {
      assert.equal(image.provider, "xberg-paddle");
      assert.equal((await rag.status()).ocr.autoCoverage.length, 5);
    }
    const embed = await rag.embed([
      "The library has science books.",
      "La biblioteca ha libri di scienza.",
    ]).catch((error) => ({ disabled: error.code }));
    assert.equal(embed.disabled, "EMBEDDING_DISABLED");
    results.push({
      driver,
      productVersion: VERSION,
      productSha256,
      platform: platform,
      runtime: runtime,
      timings: { indexMs, unchangedMs, transcribeVideoMs, ocrImageMs },
      report,
      searchableChannels: [
        ...new Set(
          citations.map((citation) => citation.locator.channel ?? "document"),
        ),
      ],
      transcriptionSegments: transcript.segments.length,
      ocrProvider: image.provider,
    });
    const classified = await rag._providers.classify(rawVideo);
    assert.equal(classified.mediaType, "video");
    assert.equal(classified.durationEvidence, "packet-timestamps");
    assert.ok(
      classified.durationSeconds > 10 && classified.durationSeconds < 14,
    );
    const rawSource = await rag.addFolder("raw");
    const rawIndex = await rag.index({ scope: { sourceIds: [rawSource.id] } });
    assert.equal(rawIndex.failed, 0);
    assert.equal(rawIndex.updated, 1);
    const rawSearch = await rag.search("library", {
      mode: "fulltext",
      scope: { sourceIds: [rawSource.id] },
    });
    assert.ok(
      rawSearch.hits.some((hit) =>
        hit.citations.some((citation) =>
          citation.locator.channel === "video-ocr"
        )
      ),
    );
    results.at(-1).elementaryVideo = {
      indexed: true,
      durationEvidence: classified.durationEvidence,
      seconds: classified.durationSeconds,
      searchableOcr: true,
    };
    await rag.removeFolder(rawSource.id);
  } finally {
    await rag.close();
  }
  const limited = await Rag.init({
    ...config,
    indexing: { video: { maxDurationSeconds: 1 } },
  });
  try {
    await limited.addFolder("input");
    const report = await limited.index();
    assert.equal(report.skipped, 1);
    assert.ok(
      (await limited.search("library", {
        mode: "fulltext",
        scope: { mime: ["video/*"] },
      })).hits.length >= 1,
      "a limit rejection retains the last published video content",
    );
    results.at(-1).durationLimit = {
      skipped: report.skipped,
      errors: report.errors.map((item) => item.code),
    };
  } finally {
    await limited.close();
  }
}
if (ocrMode === "default") {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const deadline = Promise.withResolvers();
  const timer = setTimeout(
    () => deadline.reject(new Error("OCR hook timeout")),
    15000,
  );
  const requests = [];
  const rag = await Rag.init({
    rootDir: directory,
    storageDir: await temporaryDirectory({ dir: directory, prefix: "shared-" }),
    transcribe: false,
    hookVersion: {
      ocr: "concurrent-ocr-v1",
      embedding: "concurrent-vectors-v1",
    },
    ocr: async (request, next) => {
      requests.push(request.document?.path ?? "direct");
      if (request.document) {
        entered.resolve();
        await resume.promise;
        return { text: "science library", provider: "fixture-hook" };
      }
      return await next();
    },
    embedding: ({ texts }) => ({ vectors: texts.map(() => [1, 0, 1]) }),
  });
  let indexing;
  try {
    await rag.addFolder("input");
    indexing = rag.index({ scope: { paths: ["input/scanned.pdf"] } });
    await Promise.race([entered.promise, deadline.promise]);
    const [image, embedded] = await Promise.race([
      Promise.all([
        rag.ocr(path.resolve("build/fixtures/en.png")),
        rag.embed(["science query"], { role: "query" }),
      ]),
      deadline.promise,
    ]);
    assert.match(image.text.toLowerCase(), /library/);
    assert.equal(image.provider, "xberg-paddle");
    assert.deepEqual(embedded.vectors, [[1, 0, 1]]);
    resume.resolve();
    assert.equal((await indexing).updated, 1);
    assert.equal(requests[0], path.join(directory, "input/scanned.pdf"));
    assert.equal(requests.filter((name) => name === "direct").length, 1);
    assert.ok(
      requests.every((name) =>
        name === "direct" || name === path.join(directory, "input/scanned.pdf")
      ),
    );
    const found = await rag.search("science", {
      mode: "hybrid",
      refresh: "none",
    });
    assert.equal(found.hits[0].citations[0].relativePath, "input/scanned.pdf");
    results[0].sharedProviderIsolation = {
      blockedNativePdfOcr: true,
      concurrentDirectOcrNext: true,
      concurrentDirectEmbedding: true,
      documentContextPreserved: true,
    };
  } finally {
    clearTimeout(timer);
    resume.resolve();
    await indexing?.catch(() => {});
    await rag.close();
  }
}
await fs.writeFile(
  `build/results/rag-native-${
    runtimeName === "deno" ? "v2" : "bun"
  }-${ocrMode}.json`,
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results));
