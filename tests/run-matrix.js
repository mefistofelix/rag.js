import * as path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const build = path.join(root, "build");
await Deno.mkdir(path.join(build, "results"), { recursive: true });

async function command(executable, args) {
  const result = await new Deno.Command(executable, {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder();
  console.log(text.decode(result.stdout));
  console.error(text.decode(result.stderr));
  if (!result.success) throw new Error(`${executable} exited ${result.code}`);
  return result;
}

async function fixtures() {
  await command("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.Speech; Add-Type -Path 'tests/fixtures.cs' -ReferencedAssemblies 'System.dll','System.Drawing.dll',([System.Speech.Synthesis.SpeechSynthesizer].Assembly.Location),'System.Web.Extensions.dll'; [Fixtures]::Create([IO.Path]::GetFullPath('build/fixtures'))",
  ]);
  for (const language of ["en", "it"]) {
    for (
      const [extension, codec] of [
        ["wav", "pcm_s16le"],
        ["mp3", "libmp3lame"],
        ["flac", "flac"],
        ["ogg", "libvorbis"],
        ["m4a", "aac"],
        ["webm", "libopus"],
      ]
    ) {
      await command(path.join(root, "tools", "ffmpeg.exe"), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        `build/fixtures/speech-${language}-original.wav`,
        "-ar",
        codec === "libopus" ? "48000" : "16000",
        "-ac",
        "1",
        "-c:a",
        codec,
        `build/fixtures/speech-${language}.${extension}`,
      ]);
    }
  }
  console.log(
    "Fixtures generated: ten OCR pages and EN/IT TTS in six audio containers.",
  );
}

const stage = Deno.args[0] ?? "probe";
if (stage === "npm") {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--node-modules-dir=auto",
      "-A",
      "npm:npm@12.2.0",
      ...Deno.args.slice(1),
    ],
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  Deno.exitCode = (await child.status).code;
} else if (stage.startsWith("bun-")) {
  const targets = {
    "bun-test": ["test", "tests/rag_test.js", "--timeout", "15000"],
    "bun-native": ["run", "tests/rag_native.js"],
    "bun-archives": ["run", "tests/rag_archives.js"],
    "bun-smoke": ["run", "tests/release_smoke.js"],
  };
  if (!targets[stage]) throw new Error(`Unknown Bun stage: ${stage}`);
  const result = await command(
    path.join(root, "tools/bun/bun-windows-x64/bun.exe"),
    [
      ...targets[stage],
      ...Deno.args.slice(1),
    ],
  );
  if (stage === "bun-test") {
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    await Deno.writeTextFile(
      path.join(build, "results/core-contracts-bun.json"),
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          platform: Deno.build,
          productSha256: createHash("sha256").update(
            await Deno.readFile("rag.js"),
          ).digest("hex"),
          passed: Number(output.match(/(\d+) pass\b/)?.[1]),
          failed: Number(output.match(/(\d+) fail\b/)?.[1]),
        },
        null,
        2,
      ),
    );
  }
} else if (
  stage === "package-test" || stage === "release-smoke" ||
  stage === "release-report"
) {
  await command(Deno.execPath(), [
    "run",
    "--no-config",
    "--node-modules-dir=auto",
    "-A",
    stage === "package-test"
      ? "tests/release_package.js"
      : stage === "release-report"
      ? "tests/release_report.js"
      : "tests/release_smoke.js",
    ...Deno.args.slice(1),
  ]);
} else if (stage === "indra-reference") {
  const { prepareIndra } = await import("./indra.js");
  await prepareIndra(path.join(root, "build/indra-test/cpu"));
  await command(path.join(root, "tools/uv/uv.exe"), [
    "run",
    "--python",
    "3.12",
    "--no-project",
    "tests/indra_reference.py",
    ...Deno.args.slice(1),
  ]);
} else if (stage === "fixtures") {
  await fixtures();
} else if (stage === "test") {
  const result = await command(Deno.execPath(), [
    "test",
    "--no-config",
    "--node-modules-dir=auto",
    "-A",
    "tests/rag_test.js",
    ...Deno.args.slice(1),
  ]);
  const match = new TextDecoder().decode(result.stdout).match(
    /(\d+) passed \| (\d+) failed/,
  );
  await Deno.writeTextFile(
    path.join(build, "results/core-contracts-v2.json"),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        platform: Deno.build,
        runtime: Deno.version,
        productSha256: createHash("sha256").update(
          await Deno.readFile("rag.js"),
        ).digest("hex"),
        passed: match ? Number(match[1]) : null,
        failed: match ? Number(match[2]) : null,
      },
      null,
      2,
    ),
  );
} else if (stage === "native") {
  try {
    await Deno.stat("build/fixtures/speech-en.m4a");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await fixtures();
  }
  await command(Deno.execPath(), [
    "run",
    "--no-config",
    "--node-modules-dir=auto",
    "-A",
    "tests/rag_native.js",
    ...Deno.args.slice(1),
  ]);
} else if (
  [
    "gpu-runtime",
    "full-corpus",
    "full-search",
    "full-report",
    "gpu-report",
    "xberg-hooks",
    "rag_archives",
    "xberg-corpus",
    "xberg-policy",
    "full-search-audit",
    "verification-report",
    "runtime-report",
    "indra-report",
    "indra-quality-report",
    "fastembed-gpu",
    "fastembed-long",
    "fastembed-report",
    "vector-oracle",
    "simplification",
  ]
    .includes(stage)
) {
  await command(Deno.execPath(), [
    "run",
    "--no-config",
    "--node-modules-dir=auto",
    "-A",
    `tests/${stage}.js`,
    ...Deno.args.slice(1),
  ]);
} else if (stage === "benchmark") {
  await command(Deno.execPath(), [
    "run",
    "--no-config",
    "--node-modules-dir=auto",
    "-A",
    [
        "asr",
        "gpu",
        "ocr",
        "onnx",
        "xberg-batch",
        "runtime",
        "indra",
        "indra-quality",
        "fastembed",
      ]
        .includes(Deno.args[1])
      ? `tests/benchmark_${Deno.args[1].replaceAll("-", "_")}.js`
      : "tests/benchmark.js",
    ...Deno.args.slice(
      [
          "asr",
          "gpu",
          "ocr",
          "onnx",
          "xberg-batch",
          "runtime",
          "indra",
          "indra-quality",
          "fastembed",
        ]
          .includes(
            Deno.args[1],
          )
        ? 2
        : 1,
    ),
  ]);
} else if (["select-corpus", "verify-corpus", "corpus"].includes(stage)) {
  await command(Deno.execPath(), [
    "run",
    "--no-config",
    "--node-modules-dir=auto",
    "-A",
    stage === "corpus" ? "tests/rag_corpus.js" : `tests/${stage}.js`,
    ...Deno.args.slice(1),
  ]);
} else if (stage === "fleurs") {
  await import("./fleurs.js");
} else if (stage === "audit") {
  await import("./audit.js");
} else if (stage === "native-info") {
  await import("./native-info.js");
} else if (stage === "glob") {
  await import("./glob.js");
} else if (stage === "report") {
  await import("./report.js");
} else if (stage === "performance-report") {
  await import("./performance-report.js");
} else if (stage === "all") {
  if (Deno.build.os !== "windows") {
    throw new Error(
      "Fixture generation currently requires Windows fonts and offline TTS voices; see AGENTS.md.",
    );
  }
  await fixtures();
  await import("./fleurs.js");
  await import("./audit.js");
  await import("./native-info.js");
  await import("./glob.js");
  const jobs = [
    ["probe"],
    ["ocr-native"],
    ["ocr-hook"],
    ...["english", "latin", "western", "matching", "broad", "osd", "auto"]
      .map((profile) => ["ocr-tess", profile]),
    ...["english", "latin", "matching", "broad", "broad-compatible", "auto"]
      .map((profile) => ["ocr-xberg", profile]),
    ...["asr-cpp", "asr-nodeav", "asr-sherpa", "asr-xberg"]
      .flatMap((provider) =>
        ["default", "multilingual", "formats"]
          .map((profile) => [provider, profile])
      ),
    ...["default", "formats", "stable", "stable-multilingual", "stable-formats"]
      .map((profile) => ["asr-fugood", profile]),
    ["asr-sherpa", "float-multilingual"],
  ];
  for (const job of jobs) {
    console.log(`Running ${job.join(" ")}`);
    await command(Deno.execPath(), [
      "run",
      "--no-config",
      "--node-modules-dir=auto",
      "-A",
      "tests/case.js",
      ...job,
    ]);
  }
  await import("./report.js");
} else {
  await command(Deno.execPath(), [
    "run",
    "--no-config",
    "--node-modules-dir=auto",
    "-A",
    "tests/case.js",
    ...Deno.args,
  ]);
}
