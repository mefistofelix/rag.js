// CUDA requests must either execute or preserve the native failure reason.
import * as path from "node:path";
import assert from "node:assert/strict";
import { Rag } from "../rag.js";
import { gpuEnvironment } from "./gpu-runtime.js";

const directory = path.resolve("build/onnx-comparison");
await Deno.mkdir(directory, { recursive: true });
if (Deno.args[0] === "worker") {
  const kind = Deno.args[1], provider = Deno.args[2];
  const rag = await Rag.init({
    // Reuse models, never extraction/query results, between sequential workers.
    storageDir: kind === "embedding"
      ? "build/oa/e"
      : "build/ocr-comparison/paddle",
    embedding: kind === "embedding"
      ? { acceleration: { provider, deviceId: 0 } }
      : false,
    ocr: kind === "ocr"
      ? {
        mode: "paddle",
        languages: "latin",
        acceleration: { provider, deviceId: 0 },
      }
      : false,
    transcribe: false,
  });
  const rows = [];
  try {
    for (let i = 0; i < 12; i++) {
      const start = performance.now();
      try {
        const result = kind === "embedding"
          ? await rag.embed([
            "La biblioteca contiene libri di scienza e storia.",
          ], { role: "query" })
          : await rag.ocr("build/fixtures/en.png");
        rows.push({
          ms: performance.now() - start,
          vectors: result.vectors,
          text: result.text,
          warnings: result.warnings,
        });
      } catch (error) {
        rows.push({
          ms: performance.now() - start,
          error: String(error),
          code: error.code,
        });
        break;
      }
    }
  } finally {
    await rag.close();
  }
  console.log(JSON.stringify({ kind, provider, rows }));
} else {
  const results = [];
  for (const kind of ["embedding", "ocr"]) {
    for (const provider of ["cpu", "cuda"]) {
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-config",
          "--node-modules-dir=auto",
          "-A",
          import.meta.filename,
          "worker",
          kind,
          provider,
        ],
        env: provider === "cuda" ? gpuEnvironment() : {},
        stdout: "piped",
        stderr: "piped",
      });
      const result = await child.output();
      const stdout = new TextDecoder().decode(result.stdout);
      const stderr = new TextDecoder().decode(result.stderr);
      await Deno.writeTextFile(
        path.join(directory, `${kind}-${provider}.log`),
        stdout + stderr,
      );
      assert.ok(result.success, stderr);
      const parsed = JSON.parse(stdout.trim().split("\n").at(-1));
      if (provider === "cpu") assert.equal(parsed.rows.length, 12);
      results.push(parsed);
      const { vectors: _vectors, text: _text, ...sample } = parsed.rows[0];
      console.log(JSON.stringify({ kind, provider, sample }));
    }
  }
  await Deno.writeTextFile(
    path.join(directory, "results.json"),
    JSON.stringify(
      {
        target: Deno.build,
        deno: Deno.version,
        runtime: "ONNX Runtime 1.24.1 GPU / CUDA 12.9 / cuDNN 9.27",
        results,
      },
      null,
      2,
    ),
  );
}
