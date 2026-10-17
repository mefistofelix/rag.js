// Compare public multilingual fixtures and private photo controls. Raw output
// stays under build/; published reports must contain aggregate metrics only.
import * as path from "node:path";
import assert from "node:assert/strict";
import { Rag } from "../rag.js";

const output = path.resolve("build/ocr-comparison");
await Deno.mkdir(output, { recursive: true });
const profile = Deno.args[0] ?? "tesseract";
if (!["tesseract", "paddle"].includes(profile)) {
  throw new Error("Choose tesseract or paddle");
}
const storageDir = path.join(output, profile);
if (profile === "tesseract") {
  const directory = path.join(storageDir, "models/tessdata");
  await Deno.mkdir(directory, { recursive: true });
  for (const name of ["Latin", "Cyrillic", "Arabic", "chi_sim"]) {
    await Deno.copyFile(
      `build/models/tessdata/${name}.traineddata`,
      path.join(directory, `${name}.traineddata`),
    );
  }
}

function normalize(text) {
  return Array.from(
    text.normalize("NFKC").toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim(),
  );
}

function cer(expected, actual, noWhitespace = false) {
  const clean = (text) =>
    noWhitespace
      ? normalize(text).filter((char) => !/\s/u.test(char))
      : normalize(text);
  const a = clean(expected), b = clean(actual);
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

const rag = await Rag.init({
  storageDir,
  embedding: false,
  transcribe: false,
  ocr: {
    mode: profile,
    languages: profile === "tesseract" ? "auto" : "latin",
    acceleration: { provider: "cpu" },
    paddle: { modelVersion: "pp-ocrv6", modelTier: "small" },
  },
});
const rows = [];
async function attempt(label, input, options, expected) {
  const start = performance.now();
  try {
    const result = await rag.ocr(input, options);
    assert.equal(typeof result.text, "string");
    rows.push({
      label,
      ok: true,
      ms: performance.now() - start,
      characters: result.text.length,
      cer: expected === undefined ? undefined : cer(expected, result.text),
      cerNoWhitespace: expected === undefined
        ? undefined
        : cer(expected, result.text, true),
      warnings: result.warnings,
      text: result.text,
    });
  } catch (error) {
    rows.push({
      label,
      ok: false,
      ms: performance.now() - start,
      error: String(error),
    });
  }
  await Deno.writeTextFile(
    path.join(output, `${profile}.json`),
    JSON.stringify({ deno: Deno.version, target: Deno.build, rows }, null, 2),
  );
  const { text: _text, ...summary } = rows.at(-1);
  console.log(JSON.stringify(summary));
}

try {
  const fixtures = JSON.parse(
    await Deno.readTextFile("build/fixtures/manifest.json"),
  );
  for (const fixture of fixtures.filter((item) => item.image)) {
    const language = { ru: "rus", ar: "ara", zh: "ch" }[fixture.id] ?? "latin";
    await attempt(
      fixture.id,
      path.resolve("build/fixtures", fixture.image),
      profile === "paddle" ? { languages: language } : {},
      fixture.text,
    );
  }
  if (profile === "paddle") {
    for (const id of ["ru", "ar", "zh"]) {
      const fixture = fixtures.find((item) => item.id === id);
      await attempt(
        `mixed-language-request-${id}`,
        path.resolve("build/fixtures", fixture.image),
        { languages: ["eng", "rus", "ara", "ch"] },
        fixture.text,
      );
    }
    for (const id of ["en", "it-accents", "zh", "ru", "ar"]) {
      const fixture = fixtures.find((item) => item.id === id);
      await attempt(
        `default-profile-${id}`,
        path.resolve("build/fixtures", fixture.image),
        { languages: "auto" },
        fixture.text,
      );
    }
    await assert.rejects(() =>
      rag.ocr("build/fixtures/en.png", {
        languages: "auto",
        paddle: { modelTier: "tiny" },
      }), /requires PP-OCRv6/);
  }
  // These are scene photos with small incidental writing, not blank images.
  // Character counts measure output volume, not a scored false-positive rate.
  const preflight = JSON.parse(
    await Deno.readTextFile("build/full-corpus/preflight.json"),
  );
  const photos = preflight.files.filter((item) =>
    /\.jpg$/i.test(item.relativePath)
  ).slice(0, 2);
  for (let i = 0; i < photos.length; i++) {
    await attempt(
      `private-scene-${i + 1}`,
      path.resolve("build/corpora", photos[i].relativePath),
      {},
    );
  }
  // Warm repetition distinguishes model construction/download from inference.
  const english = fixtures.find((item) => item.id === "en");
  for (let i = 0; i < 3; i++) {
    await attempt(`warm-en-${i}`, "build/fixtures/en.png", {}, english.text);
  }
} finally {
  await rag.close();
}
