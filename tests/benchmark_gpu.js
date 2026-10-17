// Verify actual GPU inference rather than treating useGpu=true as proof.
import assert from "node:assert/strict";
import * as path from "node:path";
import { Rag } from "../rag.js";

const directory = path.resolve("build/gpu-benchmark");
await Deno.mkdir(directory, { recursive: true });
if (Deno.args[0] === "worker") {
  const av = await import("npm:node-av@6.1.1");
  av.Log.setLevel(av.AV_LOG_DEBUG);
  const gpu = Deno.args[1] === "gpu";
  const input = Deno.args[2];
  const started = performance.now();
  const rag = await Rag.init({
    storageDir: path.join(directory, crypto.randomUUID().slice(0, 8)),
    embedding: false,
    ocr: false,
    transcribe: {
      useGpu: gpu,
      threads: 4,
      modelPath: path.resolve("build/models/whisper/ggml-tiny.bin"),
    },
  });
  try {
    const result = await rag.transcribe(input);
    await Deno.writeTextFile(
      path.join(directory, `transcript-${Deno.args[3]}.json`),
      JSON.stringify(result),
    );
    console.log(
      JSON.stringify({
        requestedGpu: gpu,
        ms: performance.now() - started,
        characters: result.text.length,
        segments: result.segments.length,
        durationSeconds: result.segments.at(-1)?.end ?? 0,
      }),
    );
  } finally {
    await rag.close();
  }
} else {
  const gpuInfo = await new Deno.Command("nvidia-smi.exe", {
    args: [
      "--query-gpu=name,memory.total,driver_version,compute_cap",
      "--format=csv,noheader",
    ],
    stdout: "piped",
  }).output();
  assert.ok(gpuInfo.success);
  const ffmpeg = await new Deno.Command(path.resolve("tools/ffmpeg.exe"), {
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-stream_loop",
      "2",
      "-i",
      "build/fixtures/speech-en.wav",
      "-c:a",
      "pcm_s16le",
      path.join(directory, "long.wav"),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(ffmpeg.success);
  const inputs = [{
    label: "synthetic-12s",
    path: path.resolve("build/fixtures/speech-en.wav"),
  }, { label: "synthetic-36s", path: path.join(directory, "long.wav") }];
  const preflight = JSON.parse(
    await Deno.readTextFile("build/full-corpus/preflight.json"),
  );
  const natural = preflight.media.find((item) =>
    item.hasAudio && item.durationSeconds >= 45 && item.durationSeconds < 60
  );
  if (natural) {
    inputs.push({
      label: "private-recording",
      path: path.resolve("build/corpora", natural.relativePath),
    });
  }
  const results = [];
  for (const input of inputs) {
    for (const backend of ["cpu", "gpu"]) {
      const label = `${input.label}-${backend}`;
      const monitor = new Deno.Command("nvidia-smi.exe", {
        args: [
          "--query-gpu=utilization.gpu,memory.used",
          "--format=csv,noheader,nounits",
          "-lms",
          "200",
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const monitorOutput = monitor.output();
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-config",
          "--node-modules-dir=auto",
          "-A",
          import.meta.filename,
          "worker",
          backend,
          input.path,
          label,
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 60_000);
      const output = await child.output();
      clearTimeout(timer);
      monitor.kill();
      const samplesOutput = await monitorOutput;
      const stderr = new TextDecoder().decode(output.stderr);
      await Deno.writeTextFile(path.join(directory, `${label}.log`), stderr);
      if (timedOut) {
        results.push({ input: input.label, backend, timedOut: true });
        continue;
      }
      if (!output.success) {
        throw new Error(`GPU worker failed; inspect private ${label}.log`);
      }
      const summary = JSON.parse(
        new TextDecoder().decode(output.stdout).trim().split(/\r?\n/).at(-1),
      );
      const samples = new TextDecoder().decode(samplesOutput.stdout).trim()
        .split(/\r?\n/).map((line) => line.split(",").map(Number)).filter((
          row,
        ) => row.length === 2 && row.every(Number.isFinite));
      const result = {
        input: input.label,
        backend,
        ...summary,
        vulkanLog: /Vulkan/i.test(stderr),
        cudaLog: /CUDA\d|CUDA.*backend|CUDA.*buffer/i.test(stderr),
        actualInferenceBackend:
          stderr.match(/whisper_backend_init_gpu: using ([A-Za-z0-9]+) backend/)
            ?.[1] ?? "cpu",
        openclUnsupportedWarning: /Unsupported GPU:/i.test(stderr),
        peakSystemGpuUtilization: Math.max(0, ...samples.map((row) => row[0])),
        peakSystemGpuMemoryMiB: Math.max(0, ...samples.map((row) => row[1])),
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
    const cpu = JSON.parse(
      await Deno.readTextFile(
        path.join(directory, `transcript-${input.label}-cpu.json`),
      ),
    );
    const gpu = JSON.parse(
      await Deno.readTextFile(
        path.join(directory, `transcript-${input.label}-gpu.json`),
      ),
    );
    results.at(-1).textIdenticalToCpu = cpu.text === gpu.text;
  }
  await Deno.writeTextFile(
    "build/results/benchmark-gpu.json",
    JSON.stringify(
      {
        time: new Date().toISOString(),
        gpu: new TextDecoder().decode(gpuInfo.stdout).trim(),
        packages: { nodeAv: "6.1.1", whisper: "tiny multilingual" },
        conditions:
          "Sequential workers, 4 CPU threads, GPU-memory/utilization values are whole-system samples and require corroborating native inference logs. Private transcripts and debug logs remain in build/.",
        results,
      },
      null,
      2,
    ),
  );
}
