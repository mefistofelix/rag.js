// Default-selection check: unseen legal text, controlled degradations, scripts.
// No thresholds or preprocessing changes are tuned against these cases.
import assert from "node:assert/strict";
import * as path from "node:path";
import { createHash } from "node:crypto";
import sharp from "npm:sharp@0.35.3";
import { Rag } from "../rag.js";
import { createIndra, INDRA, prepareIndra } from "./indra.js";

const root = path.resolve("build/indra-quality");
const fixturesDir = path.join(root, "fixtures");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function clean(text) {
  return Array.from(
    text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
  );
}
function cer(expected, actual) {
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
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
const phrases = {
  en: ["termination clause", "ZX-92817", "1234.56", "signed amendments"],
  it: ["risoluzione anticipata", "ZX-92817", "1234,56", "modifiche firmate"],
  ja: ["読むことができます", "返してください", "含まれています"],
  ru: ["библиотеке", "документы", "подпись"],
  zh: ["图书馆", "星期五", "签名"],
};

if (Deno.args[0] === "worker") {
  const provider = Deno.args[1];
  const manifest = JSON.parse(
    await Deno.readTextFile(path.join(fixturesDir, "manifest.json")),
  );
  const storageDir = Deno.args[2];
  const engine = provider === "indra"
    ? await createIndra({ storageDir })
    : null;
  const rag = await Rag.init({
    storageDir,
    ocr: engine?.hook ??
      { mode: "paddle", languages: "auto", acceleration: { provider: "cpu" } },
    hookVersion: { ocr: engine?.hook.version },
    embedding: false,
    transcribe: false,
  });
  const rows = [];
  try {
    for (const fixture of manifest) {
      const timings = [];
      let result;
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        result = await rag.ocr(path.join(fixturesDir, fixture.image));
        timings.push(performance.now() - started);
      }
      const actual = clean(result.text).join("");
      const anchors = phrases[fixture.language].map((phrase) => ({
        phrase,
        found: actual.includes(clean(phrase).join("")),
      }));
      const row = {
        id: fixture.id,
        language: fixture.language,
        transform: fixture.transform,
        imageSha256: digest(
          await Deno.readFile(path.join(fixturesDir, fixture.image)),
        ),
        cerNoWhitespace: cer(fixture.text, result.text),
        exactNormalized: clean(fixture.text).join("") === actual,
        anchorsFound: anchors.filter((anchor) => anchor.found).length,
        anchorsTotal: anchors.length,
        warmMedianMs: (timings[1] + timings[2]) / 2,
        firstMs: timings[0],
        text: result.text,
      };
      rows.push(row);
      const { text: _text, ...summary } = row;
      console.log(JSON.stringify(summary));
    }
    await Deno.writeTextFile(
      path.join(root, provider + ".json"),
      JSON.stringify(rows, null, 2),
    );
  } finally {
    await rag.close();
    await engine?.close();
  }
} else {
  await Deno.mkdir(fixturesDir, { recursive: true });
  const generated = await new Deno.Command("powershell.exe", {
    args: [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Speech; Add-Type -Path 'tests/fixtures.cs' -ReferencedAssemblies 'System.dll','System.Drawing.dll',([System.Speech.Synthesis.SpeechSynthesizer].Assembly.Location),'System.Web.Extensions.dll'; [Fixtures]::Quality([IO.Path]::GetFullPath('build/indra-quality/fixtures'))",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(generated.success, new TextDecoder().decode(generated.stderr));
  const bases = JSON.parse(
    await Deno.readTextFile(path.join(fixturesDir, "manifest.json")),
  );
  const manifest = [];
  for (const base of bases) {
    const variants = base.id === "ja" ? ["clean"] : [
      "clean",
      "skew3",
      "skew-3",
      "rotate90",
      "rotate180",
      "small",
      "blur",
      "jpeg",
      "faded",
    ];
    for (const transform of variants) {
      let image = sharp(path.join(fixturesDir, base.image));
      if (transform.startsWith("skew")) {
        image = image.rotate(Number(transform.slice(4)), {
          background: "white",
        });
      }
      if (transform.startsWith("rotate")) {
        image = image.rotate(Number(transform.slice(6)), {
          background: "white",
        });
      }
      if (transform === "small") image = image.resize({ width: 600 });
      if (transform === "blur") image = image.blur(0.8);
      if (transform === "faded") image = image.linear(0.4, 150);
      const id = base.id + "-" + transform;
      const bytes =
        await (transform === "jpeg" ? image.jpeg({ quality: 30 }) : image.png())
          .toBuffer();
      const filename = id + (transform === "jpeg" ? ".jpg" : ".png");
      await Deno.writeFile(path.join(fixturesDir, filename), bytes);
      manifest.push({
        id,
        language: base.id,
        transform,
        image: filename,
        text: base.text,
        font: base.font,
      });
    }
  }
  const oldFixtures = JSON.parse(
    await Deno.readTextFile("build/fixtures/manifest.json"),
  );
  for (const language of ["ru", "zh"]) {
    const base = oldFixtures.find((item) => item.id === language);
    const id = language + "-clean";
    await Deno.copyFile(
      path.resolve("build/fixtures", base.image),
      path.join(fixturesDir, id + ".png"),
    );
    manifest.push({
      id,
      language,
      transform: "clean",
      image: id + ".png",
      text: base.text,
      font: base.font,
    });
  }
  await Deno.writeTextFile(
    path.join(fixturesDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const run = await Deno.makeTempDir({ dir: root, prefix: "run-" });
  const models = await prepareIndra(path.resolve("build/indra-test/cpu"));
  const results = [];
  for (const provider of ["indra", "paddle"]) {
    const store = path.join(run, provider);
    if (provider === "indra") {
      const destination = path.join(store, "models/indra", INDRA.revision);
      await Deno.mkdir(destination, { recursive: true });
      for (const name of Object.keys(INDRA.files)) {
        await Deno.copyFile(
          path.join(models, name),
          path.join(destination, name),
        );
      }
    }
    const result = await new Deno.Command(Deno.execPath(), {
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
    const log = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    await Deno.writeTextFile(path.join(root, provider + ".log"), log);
    assert.ok(result.success, log);
    const rows = JSON.parse(
      await Deno.readTextFile(path.join(root, provider + ".json")),
    );
    const summary = {
      provider,
      cases: rows.length,
      exactCases: rows.filter((row) => row.exactNormalized).length,
      meanCer: rows.reduce((sum, row) => sum + row.cerNoWhitespace, 0) /
        rows.length,
      medianWarmMs: median(rows.map((row) => row.warmMedianMs)),
      anchorsFound: rows.reduce((sum, row) => sum + row.anchorsFound, 0),
      anchorsTotal: rows.reduce((sum, row) => sum + row.anchorsTotal, 0),
    };
    results.push({ summary, rows: rows.map(({ text: _text, ...row }) => row) });
    console.log(JSON.stringify(summary));
  }
  const report = {
    measuredAt: new Date().toISOString(),
    platform: Deno.build,
    runtime: Deno.version,
    productSha256: digest(await Deno.readFile("rag.js")),
    experimentSha256: Object.fromEntries(
      await Promise.all(
        [
          "tests/indra.js",
          "tests/benchmark_indra_quality.js",
          "tests/fixtures.cs",
        ].map(async (name) => [name, digest(await Deno.readFile(name))]),
      ),
    ),
    models: INDRA,
    results,
    notes: [
      "Public synthetic legal paragraphs with exact known text, controlled transforms, and Japanese/Russian/Chinese script controls. Not real-world OCR accuracy or OmniParseBench.",
      "Normalized CER ignores whitespace, case and punctuation; the same metric is applied to every engine. Exact phrase/identifier retention is a proxy for searchable text, not vector/hybrid retrieval quality.",
      "No model/preprocessing tuning used these cases. Equal weighting across cases is diagnostic, not an estimated production document distribution.",
      "Candidate is the actual JS Indra hook; it omits upstream deskew and learned reading order. Paddle uses production PP-OCRv6 small auto profile, not per-language recognizers.",
      "Warm latency includes image decode, OCR and processing; first call/downloads excluded. No extraction, embedding or DB work in these latency samples.",
    ],
  };
  await Deno.writeTextFile(
    path.join(root, "results.json"),
    JSON.stringify(report, null, 2),
  );
}
