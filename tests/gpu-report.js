// Export allowlisted aggregate measurements only. Never export private OCR,
// filenames, transcripts, source IDs, authenticated URLs or raw native logs.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const read = async (filename) => JSON.parse(await Deno.readTextFile(filename));
const tesseract = await read("build/ocr-comparison/tesseract.json");
const paddle = await read("build/ocr-comparison/paddle.json");
const onnx = await read("build/onnx-comparison/results.json");
const asr = await read("build/results/benchmark-gpu.json");
const hooks = await read("build/results/xberg-hooks.json");
const native = await read("build/results/rag-native-paddle.json");
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sanitized = {
  date: "2026-10-15",
  target: tesseract.target,
  deno: tesseract.deno,
  gpu: asr.gpu,
  productSha256: createHash("sha256").update(await Deno.readFile("rag.js"))
    .digest("hex"),
  packages: {
    xberg: "1.3.10",
    nodeAv: "6.1.1",
    turso: "0.8.3",
    lancedb: "0.40.0",
  },
  ocr: [tesseract, paddle].map((result, i) => ({
    provider: i === 0
      ? "tesseract-four-script-profile"
      : "paddle-v6-small-matching-language",
    rows: result.rows.map((
      { label, ok, ms, characters, cer, cerNoWhitespace },
    ) => ({
      label,
      ok,
      ms,
      characters,
      cer,
      cerNoWhitespace,
    })),
  })),
  onnx: onnx.results.map(({ kind, provider, rows }) => ({
    kind,
    provider,
    calls: rows.length,
    coldMs: rows[0].ms,
    warmMedianMs: rows.length > 1
      ? median(rows.slice(1).map((row) => row.ms))
      : undefined,
    cudaNotCompiled: rows.some((row) =>
      row.error?.includes("compiled without CUDA support")
    ),
    success: rows.every((row) => !row.error),
  })),
  asr: asr.results.map((
    {
      input,
      backend,
      ms,
      durationSeconds,
      characters,
      actualInferenceBackend,
      peakSystemGpuMemoryMiB,
    },
  ) => ({
    input,
    backend,
    ms,
    durationSeconds,
    characters,
    actualInferenceBackend,
    peakSystemGpuMemoryMiB,
  })),
  xbergEmbeddingPlugin: {
    asyncEmbeddingDispatch: hooks.asyncEmbeddingDispatch,
    independentUnregister: hooks.independentUnregister,
    gpuInferenceTested: false,
  },
  nativePaddle: native.map((
    { driver, report, elementaryVideo, ocrProvider },
  ) => ({
    driver,
    failed: report.failed,
    indexed: report.updated,
    imageOnlyPdfSearchable: true,
    elementaryVideo,
    ocrProvider,
  })),
};
assert.ok(
  sanitized.onnx.filter((row) => row.provider === "cuda").every((row) =>
    row.cudaNotCompiled
  ),
);
await Deno.writeTextFile(
  "reports/gpu-ocr-2026-10-15.json",
  JSON.stringify(sanitized, null, 2),
);
console.log("Published sanitized OCR/GPU JSON measurements.");
