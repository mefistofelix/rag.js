import * as path from "node:path";
import { createRequire } from "node:module";

const stage = Deno.args[0];
const profile = Deno.args[1] ?? "default";
const modelDirectory = path.resolve("build/models");
const fixtureDirectory = path.resolve("build/fixtures");
const resultPath = path.resolve(`build/results/${stage}-${profile}.json`);
const manifest = JSON.parse(
  await Deno.readTextFile(path.join(fixtureDirectory, "manifest.json")),
);
const rows = [];
const start = Date.now();

async function save() {
  await Deno.writeTextFile(
    resultPath,
    JSON.stringify(
      {
        stage,
        profile,
        environment: { deno: Deno.version, target: Deno.build },
        elapsedMs: Date.now() - start,
        rows,
      },
      null,
      2,
    ),
  );
}

function normalize(text) {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ").trim();
}

function cer(expected, actual) {
  const a = Array.from(normalize(expected));
  const b = Array.from(normalize(actual));
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] / Math.max(1, a.length);
}

async function attempt(id, expected, operation) {
  const before = performance.now();
  try {
    const output = await operation();
    const text = typeof output === "string" ? output : output.text ?? "";
    rows.push({
      id,
      ok: true,
      ms: Math.round(performance.now() - before),
      text,
      cer: cer(expected, text),
      details: typeof output === "string" ? undefined : output,
    });
  } catch (error) {
    rows.push({
      id,
      ok: false,
      ms: Math.round(performance.now() - before),
      error: String(error),
    });
  }
  await save();
  const row = rows.at(-1);
  console.log(
    JSON.stringify({
      ...row,
      text: row.text?.slice(0, 180),
      details: undefined,
    }),
  );
}

async function download(url, destination) {
  try {
    if ((await Deno.stat(destination)).size > 0) return destination;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(path.dirname(destination), { recursive: true });
  console.log(`download ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const file = await Deno.open(destination + ".part", {
    create: true,
    truncate: true,
    write: true,
  });
  await response.body.pipeTo(file.writable);
  await Deno.rename(destination + ".part", destination);
  return destination;
}

const fastRevision = "87416418657359cb625c412a48b6e1d6d41c29bd";
const legacyRevision = "ced78752cc61322fb554c280d13360b35b8684e4";
const tessDirectory = path.join(modelDirectory, "tessdata");
async function tessdata(language) {
  const script = /^[A-Z]/.test(language);
  const revision = language === "osd" ? legacyRevision : fastRevision;
  const repository = language === "osd" ? "tessdata" : "tessdata_fast";
  return await download(
    `https://raw.githubusercontent.com/tesseract-ocr/${repository}/${revision}/${
      script ? "script/" : ""
    }${language}.traineddata`,
    path.join(tessDirectory, language + ".traineddata"),
  );
}

const languages = {
  english: ["eng"],
  italian: ["ita"],
  western: ["eng", "ita", "fra", "deu", "spa"],
  latin: ["Latin"],
  broad: ["Latin", "Cyrillic", "Arabic", "HanS"],
  "broad-compatible": ["Latin", "Cyrillic", "Arabic", "chi_sim"],
  auto: ["auto"],
};
const matching = {
  en: "eng",
  it: "ita",
  "it-accents": "ita",
  fr: "fra",
  de: "deu",
  es: "spa",
  ru: "rus",
  zh: "chi_sim",
  ar: "ara",
  "mixed-latin": "Latin",
};

if (stage === "ocr-native") {
  const auto = await import("npm:@mefistofelix/auto.js@0.1.5");
  for (const fixture of manifest.filter((item) => item.image)) {
    await attempt(fixture.id, fixture.text, async () => {
      const image = await auto.vips.decodeImage(
        await Deno.readFile(path.join(fixtureDirectory, fixture.image)),
      );
      const result = await auto.ocr({ provider: "native", image });
      if (!result) throw new Error("Native OCR unavailable/null");
      return { text: result.text };
    });
  }
}

if (stage === "ocr-tess") {
  const tess = await import("npm:tesseract.js@7.0.0");
  const cachePath = path.join(modelDirectory, "tess-js-cache");
  await Deno.mkdir(cachePath, { recursive: true });
  const workers = new Map();
  let detector;
  try {
    if (profile === "osd") {
      await tessdata("osd");
      detector = await tess.createWorker("osd", 0, {
        langPath: tessDirectory,
        cachePath,
        gzip: false,
        legacyCore: true,
        legacyLang: true,
        errorHandler: (error) =>
          console.error("tesseract detector:", String(error)),
      });
    }
    for (const fixture of manifest.filter((item) => item.image)) {
      await attempt(fixture.id, fixture.text, async () => {
        let selected = profile === "matching"
          ? [matching[fixture.id]]
          : languages[profile];
        let detection;
        const bytes = await Deno.readFile(
          path.join(fixtureDirectory, fixture.image),
        );
        if (profile === "osd") {
          detection = (await detector.detect(bytes)).data;
          const scriptMap = {
            Latin: "Latin",
            Cyrillic: "Cyrillic",
            Arabic: "Arabic",
            Han: "HanS",
            Japanese: "Japanese",
          };
          if (!scriptMap[detection.script]) {
            throw new Error(
              `Unsupported/inconclusive OSD script: ${
                JSON.stringify(detection)
              }`,
            );
          }
          selected = [scriptMap[detection.script]];
        }
        if (profile !== "auto") {
          for (const lang of selected) await tessdata(lang);
        }
        const key = selected.join("+");
        if (!workers.has(key)) {
          let rejectWorker;
          const failed = new Promise((_, reject) => {
            rejectWorker = reject;
          });
          const worker = await Promise.race([
            tess.createWorker(selected, 1, {
              langPath: tessDirectory,
              cachePath,
              gzip: false,
              errorHandler: (error) => rejectWorker(new Error(String(error))),
            }),
            failed,
          ]);
          await worker.setParameters({ tessedit_pageseg_mode: "6" });
          workers.set(key, worker);
        }
        const output = await workers.get(key).recognize(bytes);
        return {
          text: output.data.text,
          confidence: output.data.confidence,
          languages: selected,
          detection,
        };
      });
      if (profile === "auto") break;
    }
  } finally {
    for (const worker of workers.values()) await worker.terminate();
    if (detector) await detector.terminate();
  }
  if (profile === "auto") Deno.exit(0);
}

if (stage === "ocr-xberg" || stage === "ocr-hook") {
  const xberg = await import("npm:@xberg-io/xberg@1.3.10");
  if (stage === "ocr-hook") {
    const auto = await import("npm:@mefistofelix/auto.js@0.1.5");
    xberg.registerOcrBackend({
      name: () => "rag-test-native",
      version: () => "1",
      initialize() {},
      shutdown() {},
      backendType: () => xberg.OcrBackendType.Custom,
      supportsLanguage: () => true,
      processImage: async (input) => {
        const bytes = Array.isArray(input) ? input[0] : input;
        const image = await auto.vips.decodeImage(new Uint8Array(bytes));
        const output = await auto.ocr({ provider: "native", image });
        if (!output) throw new Error("Native OCR unavailable/null");
        return {
          content: output.text,
          mimeType: "text/plain",
          metadata: {},
          tables: [],
        };
      },
    });
  }
  for (const fixture of manifest.filter((item) => item.image)) {
    await attempt(fixture.id, fixture.text, async () => {
      const selected = profile === "matching"
        ? [matching[fixture.id]]
        : languages[profile] ?? ["eng"];
      if (stage !== "ocr-hook" && profile !== "auto") {
        for (const lang of selected) {
          await tessdata(lang);
        }
      }
      Deno.env.set("TESSDATA_PREFIX", tessDirectory);
      const result = await xberg.extract({
        kind: xberg.ExtractInputKind.Bytes,
        bytes: await Deno.readFile(path.join(fixtureDirectory, fixture.image)),
        mimeType: "image/png",
        filename: fixture.image,
      }, {
        useCache: false,
        forceOcr: true,
        ocr: {
          backend: stage === "ocr-hook" ? "rag-test-native" : "tesseract",
          language: selected,
          tesseractConfig: { psm: 6, oem: 1 },
        },
      });
      return {
        text: result.results.map((item) => item.content ?? "").join("\n"),
        warnings: result.warnings,
      };
    });
  }
}

const mime = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  webm: "audio/webm",
};
const asrStage = stage.startsWith("asr-");
if (asrStage) {
  const modelPath = await download(
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin",
    path.join(modelDirectory, "whisper", "ggml-tiny.bin"),
  );
  let run;
  let release;
  if (stage === "asr-cpp") {
    const cpp = createRequire(import.meta.url)("whisper-cpp-node");
    const context = cpp.createWhisperContext({
      model: modelPath,
      use_gpu: false,
      no_prints: true,
    });
    release = () => context.free();
    run = async (file, language) => {
      const result = await cpp.transcribeAsync(context, {
        fname_inp: file,
        language,
        n_threads: 4,
        translate: false,
        no_prints: true,
        no_timestamps: false,
      });
      return {
        text: result.segments.map((segment) => segment.text).join(" "),
        segments: result.segments,
        language: result.language,
      };
    };
  }
  if (stage === "asr-fugood") {
    const whisper = profile.startsWith("stable")
      ? await import("npm:@fugood/whisper.node@1.1.3")
      : await import("npm:@fugood/whisper.node@1.2.0-rc.1");
    const context = await whisper.initWhisper({
      filePath: modelPath,
      useGpu: false,
    }, "default");
    release = () => context.release();
    run = async (file, language) => {
      const output = await context.transcribeFile(file, {
        language,
        maxThreads: 4,
        translate: false,
      }).promise;
      return {
        text: output.result ?? output.segments?.map((segment) =>
          segment.text
        ).join(" ") ?? "",
        result: output,
      };
    };
  }
  if (stage === "asr-xberg") {
    const xberg = await import("npm:@xberg-io/xberg@1.3.10");
    run = async (file, language, extension) => {
      const config = {
        enabled: true,
        model: "tiny",
        modelCacheDir: path.join(modelDirectory, "xberg-asr"),
        timestamps: false,
      };
      if (language !== "omitted") config.language = language;
      const result = await xberg.extract({
        kind: xberg.ExtractInputKind.Bytes,
        bytes: await Deno.readFile(file),
        filename: path.basename(file),
        mimeType: mime[extension],
      }, { useCache: false, transcription: config });
      return {
        text: result.results.map((item) => item.content ?? "").join("\n"),
        warnings: result.warnings,
      };
    };
  }
  if (stage === "asr-nodeav") {
    const av = await import("npm:node-av@6.1.1");
    av.Log.setLevel(av.AV_LOG_ERROR);
    run = async (file, language) => {
      const input = await av.Demuxer.open(file);
      const stream = input.audio(0);
      const decoder = await av.Decoder.create(stream);
      const transcriber = await av.WhisperTranscriber.create({
        model: "tiny",
        modelDir: path.dirname(modelPath),
        language,
        useGpu: false,
        queue: 30,
      });
      const segments = [];
      try {
        for await (
          const segment of transcriber.transcribe(
            decoder.frames(input.packets(stream.index)),
          )
        ) segments.push(segment);
        return {
          text: segments.map((segment) => segment.text).join(" "),
          segments,
        };
      } finally {
        transcriber.close();
        decoder.close();
        await input.close();
      }
    };
  }
  if (stage === "asr-sherpa") {
    const sherpa = await import("npm:sherpa-onnx-node@1.13.8");
    const modelBase =
      "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/65176e2deb88badc814a94058666cadccc29b61c";
    const directory = path.join(modelDirectory, "sherpa-tiny");
    const variant = profile.startsWith("float") ? "" : ".int8";
    const encoder = await download(
      `${modelBase}/tiny-encoder${variant}.onnx`,
      path.join(directory, `tiny-encoder${variant}.onnx`),
    );
    const decoder = await download(
      `${modelBase}/tiny-decoder${variant}.onnx`,
      path.join(directory, `tiny-decoder${variant}.onnx`),
    );
    const tokens = await download(
      `${modelBase}/tiny-tokens.txt`,
      path.join(directory, "tiny-tokens.txt"),
    );
    const recognizers = new Map();
    run = (file, language) => {
      const actualLanguage = language === "auto" ? "" : language;
      if (!recognizers.has(language)) {
        recognizers.set(
          language,
          new sherpa.OfflineRecognizer({
            modelConfig: {
              whisper: {
                encoder,
                decoder,
                language: actualLanguage,
                task: "transcribe",
              },
              tokens,
              numThreads: 4,
              provider: "cpu",
              debug: false,
            },
          }),
        );
      }
      const recognizer = recognizers.get(language);
      const wave = sherpa.readWave(file);
      const stream = recognizer.createStream();
      stream.acceptWaveform({
        sampleRate: wave.sampleRate,
        samples: wave.samples,
      });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      return { text: result.text, result };
    };
  }
  try {
    if (profile.endsWith("formats")) {
      for (const extension of Object.keys(mime)) {
        const text = await Deno.readTextFile(
          path.join(fixtureDirectory, "speech-en.txt"),
        );
        await attempt(
          `en-${extension}`,
          text,
          () =>
            run(
              path.join(fixtureDirectory, `speech-en.${extension}`),
              "en",
              extension,
            ),
        );
      }
    } else {
      const spokenLanguages = profile.endsWith("multilingual")
        ? ["ru", "zh", "de"]
        : ["en", "it"];
      for (const language of spokenLanguages) {
        const text = await Deno.readTextFile(
          path.join(fixtureDirectory, `speech-${language}.txt`),
        );
        for (
          const forced of new Set([
            "omitted",
            "auto",
            "en",
            language === "en" ? "it" : language,
          ])
        ) {
          if (forced === "omitted" && stage !== "asr-xberg") continue;
          await attempt(
            `${language}-${forced}`,
            text,
            () =>
              run(
                path.join(fixtureDirectory, `speech-${language}.wav`),
                forced,
                "wav",
              ),
          );
        }
      }
    }
  } finally {
    if (release) await release();
  }
}

await save();
