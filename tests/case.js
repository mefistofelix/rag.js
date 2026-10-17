import * as path from "node:path";
import { createRequire } from "node:module";

const resultDir = path.resolve("build/results");
await Deno.mkdir(resultDir, { recursive: true });
const stage = Deno.args[0] ?? "probe";
const packages = {
  xberg: "npm:@xberg-io/xberg@1.3.10",
  auto: "npm:@mefistofelix/auto.js@0.1.5",
  tesseract: "npm:tesseract.js@7.0.0",
  cpp: "npm:whisper-cpp-node@0.2.12",
  fugood: "npm:@fugood/whisper.node@1.2.0-rc.1",
  nodeav: "npm:node-av@6.1.1",
  sherpa: "npm:sherpa-onnx-node@1.13.8",
};

if (stage === "probe") {
  const results = [];
  for (const [name, specifier] of Object.entries(packages)) {
    try {
      const module = await import(specifier);
      results.push({
        name,
        specifier,
        loaded: true,
        exports: Object.keys(module),
      });
      if (name === "xberg") {
        await Deno.writeTextFile(
          path.join(resultDir, "xberg-capabilities.json"),
          JSON.stringify(
            {
              doctor: module.doctor(),
              ocr: module.listOcrBackends(),
              extractors: module.listDocumentExtractors(),
              transcriptionDefaults: module.transcriptionConfigDefault(),
              ocrDefaults: module.ocrConfigDefault(),
            },
            null,
            2,
          ),
        );
      }
    } catch (error) {
      results.push({
        name,
        specifier,
        loaded: false,
        error: String(error),
        stack: error.stack,
      });
    }
    console.log(
      JSON.stringify({
        ...results.at(-1),
        exports: results.at(-1).exports?.filter((key) =>
          /whisper|transcri|ocr|extract|context|default/i.test(key)
        ),
      }),
    );
  }
  try {
    const require = createRequire(import.meta.url);
    const cpp = require("whisper-cpp-node");
    results.push({
      name: "cpp-commonjs",
      loaded: true,
      exports: Object.keys(cpp),
    });
  } catch (error) {
    results.push({
      name: "cpp-commonjs",
      loaded: false,
      error: String(error),
      stack: error.stack,
    });
  }
  console.log(JSON.stringify(results.at(-1)));
  await Deno.writeTextFile(
    path.join(resultDir, "probe.json"),
    JSON.stringify(
      {
        deno: Deno.version,
        target: Deno.build,
        results,
      },
      null,
      2,
    ),
  );
} else {
  await import("./matrix.js");
}
