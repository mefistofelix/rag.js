// Experimental hook only. FastEmbed owns tokenization, pooling and inference.
// Instances run in disposable child processes: 3.0.0 has no public close API.
import * as path from "node:path";
import { createHash } from "node:crypto";
import { EmbeddingModel, FlagEmbedding, Pooling } from "npm:fastembed@3.0.0";

export const FASTEMBED = {
  version: "3.0.0",
  onnxruntime: "1.21.0",
  tokenizer: "@anush008/tokenizers@0.0.0",
  baseRevision: "4b127809f88a5aa1569d1238032b5ff40e5879bc",
  bgeRevision: "aa8f8b060edb00e03bfdd08813a2949946c8ba55",
};

export async function prepareBge(storageDir) {
  // Seed the standard preset's public cache with immutable model downloads.
  const directory = path.join(
    storageDir,
    "models/fastembed/Qdrant_bge-small-en-v1.5-onnx-Q",
  );
  await Deno.mkdir(directory, { recursive: true });
  const names = [
    "model_optimized.onnx",
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
  ];
  for (const name of names) {
    const filename = path.join(directory, name);
    let bytes;
    try {
      bytes = await Deno.readFile(filename);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const response = await fetch(
        `https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/${FASTEMBED.bgeRevision}/${name}`,
      );
      if (!response.ok) throw new Error(`BGE ${name}: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      await Deno.writeFile(filename + ".part", bytes);
      await Deno.rename(filename + ".part", filename);
    }
    if (name === "model_optimized.onnx") {
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (
        digest !==
          "51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431"
      ) throw new Error("BGE model SHA-256 mismatch");
    }
  }
  return directory;
}

export async function createFastEmbed(
  {
    storageDir,
    modelDirectory,
    profile = "same-model",
    maxLength = 512,
    batchSize = 8,
  },
) {
  const model = profile === "same-model"
    ? EmbeddingModel.CUSTOM
    : EmbeddingModel.BGESmallENV15;
  if (!["same-model", "default"].includes(profile)) {
    throw new TypeError("Choose same-model or default");
  }
  if (profile === "default") await prepareBge(storageDir);
  const engine = await FlagEmbedding.init({
    model,
    ...(profile === "same-model"
      ? {
        modelAbsoluteDirPath: modelDirectory,
        modelName: "model.onnx",
        pooling: Pooling.Mean,
      }
      : {}),
    cacheDir: path.join(storageDir, "models/fastembed"),
    executionProviders: ["cpu"],
    maxLength,
    showDownloadProgress: false,
  });
  async function embed(
    texts,
    { role = "document", signal, batch = batchSize } = {},
  ) {
    const vectors = [];
    // Prefix each input once; do not mix E5 query/document vector spaces.
    const prefixed = texts.map((text) =>
      `${role === "query" ? "query" : "passage"}: ${text}`
    );
    signal?.throwIfAborted();
    for await (const part of engine.embed(prefixed, batch)) {
      signal?.throwIfAborted();
      vectors.push(...part);
    }
    return { vectors };
  }
  return {
    embed,
    hook: ({ texts, ...options }) => embed(texts, options),
    hookVersion: `fastembed-3:${profile}:${maxLength}:mean-or-cls:e5-roles`,
    dimensions: profile === "same-model" ? 768 : 384,
  };
}
