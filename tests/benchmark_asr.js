// Each case runs in a killable child: a native inference cannot reliably honor JS timers.
import assert from "node:assert/strict";
import * as path from "node:path";
import { Rag } from "../rag.js";

if (Deno.args[0] === "worker") {
  const threads = Deno.args[1];
  const started = performance.now();
  let text;
  if (threads === "auto") {
    const av = await import("npm:node-av@6.1.1");
    av.Log.setLevel(av.AV_LOG_ERROR);
    const input = await av.Demuxer.open("build/fixtures/speech-en.wav");
    const audio = input.audio(0);
    const decoder = await av.Decoder.create(audio);
    const transcriber = await av.WhisperTranscriber.create({
      model: "tiny",
      modelDir: path.resolve("build/models/whisper"),
      language: "auto",
      useGpu: false,
      queue: 30,
    });
    try {
      const segments = [];
      for await (
        const segment of transcriber.transcribe(
          decoder.frames(input.packets(audio.index)),
        )
      ) segments.push(segment);
      text = segments.map((segment) => segment.text).join(" ");
    } finally {
      transcriber.close();
      decoder.close();
      await input.close();
    }
  } else {
    const rag = await Rag.init({
      storageDir: `build/asr-${crypto.randomUUID().slice(0, 8)}`,
      embedding: false,
      ocr: false,
      transcribe: {
        threads: Number(threads),
        modelPath: path.resolve("build/models/whisper/ggml-tiny.bin"),
      },
    });
    try {
      text = (await rag.transcribe("build/fixtures/speech-en.wav")).text;
    } finally {
      await rag.close();
    }
  }
  assert.match(text.toLowerCase(), /library/);
  console.log(
    JSON.stringify({
      threads,
      ms: performance.now() - started,
      characters: text.length,
      expectedKeywordFound: true,
    }),
  );
} else {
  const results = [];
  for (const threads of ["auto", "1", "2", "4", "8", "16"]) {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--node-modules-dir=auto",
        "-A",
        import.meta.filename,
        "worker",
        threads,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 20_000);
    const output = await child.output();
    clearTimeout(timeout);
    if (timedOut) results.push({ threads, timedOut: true, timeoutMs: 20_000 });
    else {
      if (!output.success) {
        throw new Error(
          `ASR worker failed: ${new TextDecoder().decode(output.stderr)}`,
        );
      }
      const line = new TextDecoder().decode(output.stdout).trim().split(/\r?\n/)
        .at(-1);
      results.push(JSON.parse(line));
    }
    console.log(JSON.stringify(results.at(-1)));
  }
  await Deno.writeTextFile(
    "build/results/benchmark-asr-threads.json",
    JSON.stringify(
      {
        metadata: {
          time: new Date().toISOString(),
          deno: Deno.version.deno,
          platform: Deno.build.target,
          model: "Whisper tiny multilingual",
          inputSeconds: 12.207313,
          language: "auto",
          useGpu: false,
          note:
            "Separate sequential processes; includes module/model initialization, cached files, no resident context reuse. auto is the original NodeAV convenience wrapper; integer cases use public FilterAPI graph.nbThreads.",
        },
        results,
      },
      null,
      2,
    ),
  );
}
