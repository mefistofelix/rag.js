// Experimental Indra image OCR hook; deliberately outside the distributable.
// Geometry/CTC rules adapted from datalab-to/indra, Apache-2.0, revision below.
// Copyright Datalab. License: https://www.apache.org/licenses/LICENSE-2.0
// Changes: JS implementation, separable resize, geometric line ordering; no
// deskew, layout/table assembly or math. This is NOT the complete Indra pipeline.
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as ort from "npm:onnxruntime-node@1.30.0";
import sharp from "npm:sharp@0.35.3";

export const INDRA = {
  upstream: "3d773aeedc5d79d1d0a2a04007a9075cd71a59f4",
  revision: "ed345c7f158eddbc7dee0c6a7269afb75a94f7e8",
  runtime: "onnxruntime-node@1.30.0",
  files: {
    "det.onnx":
      "46b0050ce4c4692f887a1a9c038480223af1c7a91b3fcced2657d9cf00290dc4",
    "rec.onnx":
      "e243be069b357e56a0e867a21d7482e498df42fb19678bfb67a25f48b1f06151",
    "script.onnx":
      "5ba37030e817affede0097a7503b6829624104166c6e0b6aacecacf919fc7d11",
    "rec_cjk.onnx":
      "4cec840b55e1bb7f375daf30a2975404a867a71ac1a5bc5b1629c4909ce16baa",
    "orient.onnx":
      "8d7bfce5d08bcad55955f41ca494a7f9d9d3ed5d5b6da1f6f276d5c509590729",
    "order.onnx":
      "23635dd2324b4ccc00c408af961273a2dedd2e4f0386bc54dba678c41bcf6b46",
    "meta.json":
      "ff6ec58f91c93a475ae9505ad21c73c3ecda0b378f1d889dd83408e10832d1bb",
    "LICENSE":
      "50c88a018a7ee322e89f6b09401b237beb0cd331685879405b3db48993950a5f",
  },
};

const warnings = [
  "Experimental Indra JS: geometric line order; no deskew, tables, layout or math reconstruction.",
  "OCR covers Latin, Cyrillic, Greek, Devanagari, Bengali and Chinese; not Arabic, Hebrew, kana or Hangul. Script routing is not language detection.",
];

export async function prepareIndra(storageDir) {
  const directory = path.join(storageDir, "models", "indra", INDRA.revision);
  await Deno.mkdir(directory, { recursive: true });
  for (const name of Object.keys(INDRA.files)) {
    const filename = path.join(directory, name);
    let bytes;
    try {
      bytes = await Deno.readFile(filename);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (!bytes) {
      const response = await fetch(
        `https://huggingface.co/datalab-to/indra-ocr/resolve/${INDRA.revision}/${name}`,
      );
      if (!response.ok) {
        throw new Error(`Indra ${name}: HTTP ${response.status}`);
      }
      bytes = new Uint8Array(await response.arrayBuffer());
      await Deno.writeFile(filename + ".part", bytes);
      if (INDRA.files[name] && digest(bytes) !== INDRA.files[name]) {
        throw new Error(`Indra ${name}: SHA-256 mismatch`);
      }
      await Deno.rename(filename + ".part", filename);
    }
    if (INDRA.files[name] && digest(bytes) !== INDRA.files[name]) {
      throw new Error(`Indra ${name}: SHA-256 mismatch`);
    }
  }
  return directory;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Area resampling when shrinking, half-pixel bilinear when enlarging. Round
// only at the final byte image, matching the upstream ink-map convention.
function resize(image, width, height) {
  const horizontal = new Float32Array(width * image.height);
  const data = new Uint8Array(width * height);
  function sample(at, sourceSize, targetSize, read) {
    const scale = sourceSize / targetSize;
    if (scale <= 1) {
      const position = (at + 0.5) * scale - 0.5;
      const start = Math.floor(position);
      const fraction = position - start;
      return read(Math.max(0, start)) * (1 - fraction) +
        read(Math.min(sourceSize - 1, start + 1)) * fraction;
    }
    const start = at * scale, end = (at + 1) * scale;
    let sum = 0;
    for (let index = Math.floor(start); index < Math.ceil(end); index++) {
      sum += read(Math.min(index, sourceSize - 1)) *
        (Math.min(index + 1, end) - Math.max(index, start));
    }
    return sum / scale;
  }
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < width; x++) {
      horizontal[y * width + x] = sample(
        x,
        image.width,
        width,
        (index) => image.data[y * image.width + index],
      );
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = Math.round(sample(
        y,
        image.height,
        height,
        (index) => horizontal[index * width + x],
      ));
    }
  }
  return { data, width, height };
}

function pageInput(image, side, square = false) {
  const scale = side / Math.max(image.width, image.height);
  const small = resize(
    image,
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
  const width = square ? side : Math.ceil(small.width / 32) * 32;
  const height = square ? side : Math.ceil(small.height / 32) * 32;
  const data = new Float32Array(width * height);
  for (let y = 0; y < small.height; y++) {
    for (let x = 0; x < small.width; x++) {
      data[y * width + x] = 1 - small.data[y * small.width + x] / 255;
    }
  }
  return {
    tensor: new ort.Tensor("float32", data, [1, 1, height, width]),
    scale,
  };
}

function decodeBoxes(tensor) {
  const [, , height, width] = tensor.dims;
  const area = width * height;
  const logits = tensor.data;
  const visited = new Uint8Array(area);
  const queue = new Int32Array(area);
  const boxes = [];
  for (let first = 0; first < area; first++) {
    if (visited[first] || logits[first] <= 0) continue;
    let head = 0, tail = 1, top = 0, bottom = 0, score = 0;
    let left = width, right = 0;
    queue[0] = first;
    visited[first] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width, y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top += (y + 0.5) * 2 - logits[area + index];
      bottom += (y + 0.5) * 2 + logits[2 * area + index];
      score += 1 / (1 + Math.exp(-logits[index]));
      for (
        const next of [
          x > 0 ? index - 1 : -1,
          x + 1 < width ? index + 1 : -1,
          y > 0 ? index - width : -1,
          y + 1 < height ? index + width : -1,
        ]
      ) {
        if (next >= 0 && !visited[next] && logits[next] > 0) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    if (tail < 2) continue;
    top /= tail;
    bottom /= tail;
    const expand = 0.15 * Math.max(1, bottom - top);
    boxes.push([
      left * 2 - expand,
      top,
      right * 2 + expand,
      bottom,
      score / tail,
    ]);
  }
  return boxes;
}

function cropLine(image, box, height) {
  const lineHeight = Math.max(1, box[3] - box[1]);
  const left = Math.floor(box[0] - 0.3 * lineHeight);
  const top = Math.floor(box[1] - 0.2 * lineHeight);
  const width = Math.max(1, Math.ceil(box[2] + 0.3 * lineHeight) - left);
  const cropHeight = Math.max(1, Math.ceil(box[3] + 0.2 * lineHeight) - top);
  const data = new Uint8Array(width * cropHeight).fill(255);
  for (
    let y = Math.max(0, top);
    y < Math.min(image.height, top + cropHeight);
    y++
  ) {
    const start = Math.max(0, left), end = Math.min(image.width, left + width);
    if (end > start) {
      data.set(
        image.data.subarray(y * image.width + start, y * image.width + end),
        (y - top) * width + start - left,
      );
    }
  }
  return resize(
    { data, width, height: cropHeight },
    Math.max(8, Math.min(4096, Math.round(width * height / cropHeight))),
    height,
  );
}

function batches(crops, selected) {
  const groups = [];
  for (
    const index of [...selected].sort((a, b) => crops[a].width - crops[b].width)
  ) {
    const group = groups.at(-1);
    const width = Math.max(64, crops[index].width);
    if (
      group && group.length < 64 &&
      width <= 1.3 * Math.max(64, crops[group[0]].width) &&
      (group.length + 1) * width <= 64 * 640
    ) {
      group.push(index);
    } else groups.push([index]);
  }
  return groups;
}

function lineInput(crops, indices) {
  const height = crops[indices[0]].height;
  const width = Math.ceil(Math.max(...indices.map((i) => crops[i].width)) / 8) *
    8;
  const data = new Float32Array(indices.length * height * width);
  for (const [batch, index] of indices.entries()) {
    const crop = crops[index];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < crop.width; x++) {
        data[(batch * height + y) * width + x] = 1 -
          crop.data[y * crop.width + x] / 255;
      }
    }
  }
  return {
    x: new ort.Tensor("float32", data, [indices.length, 1, height, width]),
    widths: new ort.Tensor(
      "int64",
      BigInt64Array.from(indices, (i) => BigInt(crops[i].width)),
      [indices.length],
    ),
  };
}

/** Caller owns close(); hook may be supplied as Rag.init({ocr: engine.hook}). */
export async function createIndra(
  { storageDir, provider = "cpu", threads = 4 },
) {
  if (!["cpu", "dml", "cuda", "coreml"].includes(provider)) {
    throw new TypeError("Choose cpu, dml, cuda or coreml explicitly");
  }
  const backend = ort.listSupportedBackends().find((item) =>
    item.name === provider
  );
  if (!backend?.bundled) {
    throw new Error(`ORT Node prebuild does not bundle ${provider}`);
  }
  const directory = await prepareIndra(storageDir);
  const meta = JSON.parse(
    await Deno.readTextFile(path.join(directory, "meta.json")),
  );
  const vocabulary = JSON.parse(meta.vocab).chars;
  const chineseVocabulary = JSON.parse(meta.vocab_cjk).chars;
  const sessions = {};
  try {
    for (const name of ["det", "rec", "script", "rec_cjk", "orient"]) {
      sessions[name] = await ort.InferenceSession.create(
        path.join(directory, name + ".onnx"),
        {
          executionProviders: [provider],
          intraOpNumThreads: threads,
          interOpNumThreads: 1,
          enableCpuMemArena: false,
          enableMemPattern: provider !== "dml",
          executionMode: "sequential",
        },
      );
    }
  } catch (error) {
    await Promise.all(
      Object.values(sessions).map((session) => session.release()),
    );
    throw error;
  }
  let closed = false;
  async function run(name, feeds) {
    const outputs = await sessions[name].run(feeds);
    return sessions[name].outputNames.map((key) => outputs[key]);
  }
  async function recognize(request) {
    if (closed) throw new Error("Indra engine is closed");
    request.signal?.throwIfAborted();
    const started = performance.now();
    const decoded = await sharp(
      request.input.bytes ?? await Deno.readFile(request.input.path),
    )
      .flatten({ background: "white" }).toColourspace("b-w").raw().toBuffer({
        resolveWithObject: true,
      });
    let image = {
      data: decoded.data,
      width: decoded.info.width,
      height: decoded.info.height,
    };
    const [orientation] = await run("orient", {
      x: pageInput(image, 768, true).tensor,
    });
    const turn = orientation.data.indexOf(Math.max(...orientation.data));
    const rotation = orientation.data[turn] > 0.95 ? turn : 0;
    for (let k = 0; k < rotation; k++) {
      const data = new Uint8Array(image.data.length);
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          data[x * image.height + image.height - 1 - y] =
            image.data[y * image.width + x];
        }
      }
      image = { data, width: image.height, height: image.width };
    }
    const decodeMs = performance.now() - started;
    const detectStart = performance.now();
    async function detect(side) {
      const input = pageInput(image, side);
      const [output] = await run("det", { x: input.tensor });
      return { boxes: decodeBoxes(output), scale: input.scale };
    }
    let detection = await detect(meta.det_long_side);
    if (detection.boxes.length >= 8) {
      const height = median(detection.boxes.map((box) => box[3] - box[1]));
      const side = Math.floor(
        Math.min(2048, meta.det_long_side * 12 / Math.max(1, height)) / 32,
      ) * 32;
      if (height < 9 && side > meta.det_long_side) {
        detection = await detect(side);
      }
    }
    const boxes = detection.boxes.map((box) =>
      box.slice(0, 4).map((value, i) =>
        Math.max(
          0,
          Math.min(i % 2 ? image.height : image.width, value / detection.scale),
        )
      )
    );
    const detectMs = performance.now() - detectStart;
    const recStart = performance.now();
    const crops = boxes.map((box) => cropLine(image, box, meta.rec_height));
    const chinese = new Set();
    for (const group of batches(crops, crops.map((_, i) => i))) {
      request.signal?.throwIfAborted();
      const [probability] = await run("script", lineInput(crops, group));
      group.forEach((index, i) => {
        if (probability.data[i] > 0.5) chinese.add(index);
      });
    }
    const lines = boxes.map((box) => ({ box, text: "", confidence: 0 }));
    for (const useChinese of [false, true]) {
      const selected = crops.map((_, i) => i).filter((i) =>
        chinese.has(i) === useChinese
      );
      const vocab = useChinese ? chineseVocabulary : vocabulary;
      for (const group of batches(crops, selected)) {
        request.signal?.throwIfAborted();
        const [best, probabilities, lengths] = await run(
          useChinese ? "rec_cjk" : "rec",
          lineInput(crops, group),
        );
        const steps = best.dims[1];
        for (const [batch, index] of group.entries()) {
          let previous = 0, confidence = 0, count = 0, text = "";
          for (let step = 0; step < Number(lengths.data[batch]); step++) {
            const token = Number(best.data[batch * steps + step]);
            if (token !== 0 && token !== previous) {
              text += vocab[token - 1] ?? "";
              confidence += probabilities.data[batch * steps + step];
              count++;
            }
            previous = token;
          }
          confidence = count ? confidence / count : 0;
          // Upstream MIN_CONF, not a newly invented language/confidence detector.
          lines[index] = {
            box: boxes[index],
            text: confidence >= 0.5 ? text : "",
            confidence,
          };
        }
      }
    }
    // Explicitly geometric ordering; no claim of upstream learned layout parity.
    const rowHeight = lines.length
      ? median(boxes.map((box) => box[3] - box[1])) / 2
      : 1;
    lines.sort((a, b) =>
      Math.round((a.box[1] + a.box[3]) / 2 / rowHeight) -
        Math.round((b.box[1] + b.box[3]) / 2 / rowHeight) || a.box[0] - b.box[0]
    );
    request.signal?.throwIfAborted();
    return {
      text: lines.map((line) => line.text).join("\n"),
      provider: `indra-js-${provider}`,
      warnings: [...warnings],
      metadata: {
        modelRevision: INDRA.revision,
        providerRequested: provider,
        // ORT may place unsupported nodes on CPU; do not claim all-GPU execution.
        rotation: rotation * 90,
        coordinateSpace: "upright-image-pixels",
        lines,
        timings: {
          decodeAndOrientMs: decodeMs,
          detectMs,
          recognizeMs: performance.now() - recStart,
          totalMs: performance.now() - started,
        },
      },
    };
  }
  // Serialize this shared engine across Rag ingestion/direct contexts. Native
  // cancellation is between runs; a queued caller checks its own signal.
  let tail = Promise.resolve();
  return {
    directory,
    provider,
    hook: Object.assign((request) => {
      const operation = tail.then(() => recognize(request));
      tail = operation.catch(() => {});
      return operation;
    }, { version: `indra-js-1:${INDRA.revision}:${provider}` }),
    async close() {
      await tail;
      if (closed) return;
      closed = true;
      await Promise.all(
        Object.values(sessions).map((session) => session.release()),
      );
    },
  };
}
