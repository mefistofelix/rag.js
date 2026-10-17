// Does long-input GPU throughput improve actual default-chunk ingestion?
import assert from "node:assert/strict";
import * as path from "node:path";
import { cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EmbeddingModel, FlagEmbedding, Pooling } from "npm:fastembed@3.0.0";
import { Rag } from "../rag.js";
import { FASTEMBED } from "./fastembed.js";
import { embeddingTopics } from "./embedding-fixtures.js";

const root = path.resolve("build/fastembed-test");
const cache = path.join(root, "model-owner/models/embeddings");
const baseModel = path.join(
  cache,
  "models--xberg-io--embedding-models/snapshots",
  FASTEMBED.baseRevision,
  "multilingual-e5-base",
);
const input = path.join(root, "long-input");
if (Deno.args[0] === "worker") {
  const profile = Deno.args[1], store = Deno.args[2];
  await Deno.mkdir(store, { recursive: true });
  let owner, engine;
  if (profile === "xberg") {
    await Deno.mkdir(path.join(store, "models"), { recursive: true });
    await cp(cache, path.join(store, "models/embeddings"), { recursive: true });
    owner = await Rag.init({
      storageDir: store,
      ocr: false,
      transcribe: false,
      embedding: { acceleration: { provider: "cpu" } },
    });
  } else {
    engine = await FlagEmbedding.init({
      model: EmbeddingModel.CUSTOM,
      modelAbsoluteDirPath: baseModel,
      modelName: "model.onnx",
      pooling: Pooling.Mean,
      maxLength: 512,
      executionProviders: ["dml"],
    });
  }
  const embed = async (texts, role = "document") => {
    if (owner) return await owner.embed(texts, { role });
    const vectors = [];
    for await (
      const batch of engine.embed(
        texts.map((text) =>
          `${role === "query" ? "query" : "passage"}: ${text}`
        ),
        8,
      )
    ) vectors.push(...batch);
    return { vectors };
  };
  const long =
    "A multilingual library keeps documents about science and history. ".repeat(
      140,
    );
  const boundary = (await embed([long + "tail-A", long + "tail-B"])).vectors;
  await Deno.writeTextFile(
    path.join(root, "boundary-" + profile + ".json"),
    JSON.stringify(boundary),
  );
  const rag = await Rag.init({
    rootDir: input,
    storageDir: path.join(store, "index"),
    ocr: false,
    transcribe: false,
    embedding: ({ texts, role }) => embed(texts, role),
    hookVersion: { embedding: "long-e5-512-" + profile },
    chunking: { maxCharacters: 1200, overlap: 0 },
  });
  try {
    // Native shape and provider initialization are outside the measured index.
    await embed([embeddingTopics[0][1].repeat(8)]);
    await rag.addFolder(".");
    const started = performance.now();
    const report = await rag.index();
    const elapsed = performance.now() - started;
    assert.equal(report.failed, 0, JSON.stringify(report));
    const result = {
      profile,
      indexMs: elapsed,
      report,
      counts: (await rag.status()).counts,
    };
    await Deno.writeTextFile(
      path.join(root, "long-" + profile + ".json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    await rag.close();
    await owner?.close();
  }
} else {
  await Deno.mkdir(input, { recursive: true });
  for (const [topic, en, it] of embeddingTopics) {
    await Deno.writeTextFile(
      path.join(input, topic + "-en.txt"),
      (en + " ").repeat(18),
    );
    await Deno.writeTextFile(
      path.join(input, topic + "-it.txt"),
      (it + " ").repeat(18),
    );
  }
  const run = await Deno.makeTempDir({ dir: root, prefix: "long-" });
  const results = [];
  for (const profile of ["xberg", "dml"]) {
    const child = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--node-modules-dir=auto",
        "-A",
        import.meta.filename,
        "worker",
        profile,
        path.join(run, profile),
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const log = new TextDecoder().decode(child.stdout) +
      new TextDecoder().decode(child.stderr);
    await Deno.writeTextFile(path.join(root, "long-" + profile + ".log"), log);
    assert.ok(child.success, log);
    results.push(
      JSON.parse(
        await Deno.readTextFile(path.join(root, "long-" + profile + ".json")),
      ),
    );
  }
  const cosine = (a, b) => {
    let d = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) {
      d += a[i] * b[i];
      aa += a[i] * a[i];
      bb += b[i] * b[i];
    }
    return d / Math.sqrt(aa * bb);
  };
  const cpu = JSON.parse(
    await Deno.readTextFile(path.join(root, "boundary-xberg.json")),
  );
  const gpu = JSON.parse(
    await Deno.readTextFile(path.join(root, "boundary-dml.json")),
  );
  const report = {
    results,
    sourceSha256: createHash("sha256").update(
      await Deno.readFile(import.meta.filename),
    ).digest("hex"),
    boundary: {
      characters:
        "A multilingual library keeps documents about science and history. "
            .length * 140 + 6,
      minCrossProviderCosine: Math.min(
        ...cpu.map((vector, i) => cosine(vector, gpu[i])),
      ),
      cpuTailCosine: cosine(cpu[0], cpu[1]),
      gpuTailCosine: cosine(gpu[0], gpu[1]),
    },
    notes: [
      "Sixteen public longer text files. Actual extraction, chunking at1200/overlap0, live E5 inference and Turso publication, warm models. No OCR/ASR.",
      "Boundary inputs exceed512 tokens. Tail differences after the retained window should not change embeddings; this is not long-context support.",
    ],
  };
  assert.equal(
    results[0].report.embeddingsGenerated,
    results[1].report.embeddingsGenerated,
  );
  await Deno.writeTextFile(
    path.join(root, "long-results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
