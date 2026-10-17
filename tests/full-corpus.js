// Full private corpus experiment. All paths, transcripts and detailed errors stay in build/.
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const corpusRoot = path.resolve("build/corpora");
const directory = path.resolve("build/full-corpus");
await Deno.mkdir(directory, { recursive: true });
const mode = Deno.args[0] ?? "preflight";

async function manifest() {
  const inventory = JSON.parse(
    await Deno.readTextFile(path.join(corpusRoot, "inventory.json")),
  );
  const byId = new Map();
  for await (const entry of Deno.readDir(path.join(corpusRoot, "queues"))) {
    if (!entry.name.endsWith(".result.json")) continue;
    const rows = JSON.parse(
      await Deno.readTextFile(path.join(corpusRoot, "queues", entry.name)),
    );
    for (const row of rows) if (row.ok) byId.set(row.id, row);
  }
  return inventory.map((row) => {
    const local = byId.get(row.id);
    if (!local) throw new Error("Missing verified corpus file");
    return {
      id: row.id,
      relativePath: local.path.replaceAll("\\", "/"),
      bytes: local.bytes,
      mime: row.mime,
    };
  });
}

async function write(filename, value) {
  const destination = path.join(directory, filename);
  await Deno.writeTextFile(
    destination + ".tmp",
    JSON.stringify(value, null, 2),
  );
  await Deno.rename(destination + ".tmp", destination);
}

if (mode === "preflight") {
  const av = await import("npm:node-av@6.1.1");
  av.Log.setLevel(av.AV_LOG_ERROR);
  const files = await manifest();
  const started = performance.now();
  const types = {};
  const media = [];
  const hashes = new Map();
  let processed = 0;
  for (const item of files) {
    const filename = path.join(corpusRoot, item.relativePath);
    const extension = path.extname(filename).toLowerCase();
    types[extension] ??= { files: 0, bytes: 0 };
    types[extension].files++;
    types[extension].bytes += item.bytes;
    const digest = createHash("sha256");
    const file = await Deno.open(filename);
    for await (const bytes of file.readable) digest.update(bytes);
    item.sha256 = digest.digest("hex");
    hashes.set(item.sha256, (hashes.get(item.sha256) ?? 0) + 1);
    if (/\.(aac|mp3|m4a|wav|mp4|m2v|m4v)$/i.test(filename)) {
      let demuxer;
      try {
        demuxer = await av.Demuxer.open(filename);
        media.push({
          id: item.id,
          relativePath: item.relativePath,
          durationSeconds: demuxer.duration,
          format: demuxer.formatName,
          hasAudio: Boolean(demuxer.audio(0)),
          hasVideo: Boolean(demuxer.video(0)),
          bytes: item.bytes,
        });
      } catch (error) {
        media.push({ id: item.id, error: error.message });
      } finally {
        await demuxer?.close();
      }
    }
    processed++;
    if (processed % 250 === 0) {
      console.log(
        JSON.stringify({ preflightFiles: processed, total: files.length }),
      );
    }
  }
  const summary = {
    files: files.length,
    bytes: files.reduce((sum, item) => sum + item.bytes, 0),
    uniqueContents: hashes.size,
    duplicatePaths: files.length - hashes.size,
    types,
    mediaFiles: media.length,
    audioHours: media.filter((item) =>
      item.hasAudio
    ).reduce((sum, item) =>
      sum + (item.durationSeconds > 0 ? item.durationSeconds : 0), 0) / 3600,
    videoHours: media.filter((item) =>
      item.hasVideo
    ).reduce((sum, item) =>
      sum + (item.durationSeconds > 0 ? item.durationSeconds : 0), 0) / 3600,
    mediaProbeErrors: media.filter((item) =>
      item.error
    ).length,
    mediaUnknownDuration: media.filter((item) =>
      !item.error && !(item.durationSeconds > 0)
    ).length,
    ms: performance.now() - started,
  };
  await write("preflight.json", { summary, files, media });
  console.log(JSON.stringify(summary));
} else if (mode === "index") {
  const driver = Deno.args[1];
  const token = Deno.args[2];
  if (driver !== "turso" || !/^[a-z0-9-]+$/.test(token)) {
    throw new Error("Invalid benchmark identity");
  }
  const runDir = path.join(directory, token);
  await Deno.mkdir(runDir, { recursive: true });
  const snapshot = path.join(runDir, "rag-source.js");
  try {
    await Deno.stat(snapshot);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await Deno.copyFile("rag.js", snapshot);
  }
  const { Rag } = await import(pathToFileURL(snapshot).href);
  const storageDir = path.resolve(
    "build/fu",
    token,
    "t",
  );
  const preflight = JSON.parse(
    await Deno.readTextFile(path.join(directory, "preflight.json")),
  );
  const files = preflight.files;
  const fileByPath = new Map(
    files.map((item) => [path.resolve(corpusRoot, item.relativePath), item]),
  );
  const media = new Map(preflight.media.map((item) => [item.id, item]));
  const phases = {};
  let state;
  try {
    state = JSON.parse(
      await Deno.readTextFile(path.join(runDir, `${driver}.json`)),
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const sourceSha256 = createHash("sha256").update(
    await Deno.readFile(snapshot),
  ).digest("hex");
  if (state && state.sourceSha256 !== sourceSha256) {
    throw new Error(
      "Resume with the same product source or use another benchmark token",
    );
  }
  state ??= {
    driver,
    token,
    sourceSha256,
    files: files.length,
    completedIds: [],
    batches: [],
    records: [],
    indexingMs: 0,
    setupMs: 0,
    startedAt: new Date().toISOString(),
  };
  const completed = new Set(state.completedIds);
  const startedSetup = performance.now();
  const copyTree = async (source, destination) => {
    await Deno.mkdir(destination, { recursive: true });
    for await (const entry of Deno.readDir(source)) {
      const src = path.join(source, entry.name),
        dst = path.join(destination, entry.name);
      if (entry.isDirectory) await copyTree(src, dst);
      else if (entry.isFile) {
        try {
          if ((await Deno.stat(src)).size === (await Deno.stat(dst)).size) {
            continue;
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await Deno.copyFile(src, dst);
      }
    }
  };
  let modelOwner;
  for await (const entry of Deno.readDir("build")) {
    if (entry.isDirectory && entry.name.startsWith("embedding-smoke-")) {
      modelOwner = path.resolve("build", entry.name, "models/embeddings");
      break;
    }
  }
  if (!modelOwner) {
    throw new Error(
      "Run the multilingual embedding benchmark to seed verified local model files first",
    );
  }
  await copyTree(modelOwner, path.join(storageDir, "models/embeddings"));
  const tesseract = Deno.env.get("RAG_FULL_OCR") === "tesseract";
  await copyTree(
    path.resolve(
      tesseract
        ? "build/models/tessdata"
        : "build/ocr-comparison/paddle/models/paddle",
    ),
    path.join(storageDir, tesseract ? "models/tessdata" : "models/paddle"),
  );
  await Deno.mkdir(path.join(storageDir, "models/whisper"), {
    recursive: true,
  });
  await Deno.copyFile(
    "build/models/whisper/ggml-tiny.bin",
    path.join(storageDir, "models/whisper/ggml-tiny.bin"),
  );
  const av = await import("npm:node-av@6.1.1");
  av.Log.setLevel(av.AV_LOG_ERROR);
  const config = {
    rootDir: corpusRoot,
    storageDir,
    storage: { driver },
    ocr: tesseract
      ? { mode: "tesseract", languages: "auto" }
      : { mode: "paddle", languages: "auto" },
    transcribe: { useGpu: true, threads: 4 },
    indexing: {
      maxFileBytes: 1024 ** 3,
      maxPages: 100_000,
      maxArchiveBytes: 2 * 1024 ** 3,
      maxArchiveEntries: 100_000,
      maxArchiveDepth: 10,
      audio: { maxFileBytes: 1024 ** 3, maxDurationSeconds: 24 * 3600 },
      video: {
        maxFileBytes: 2 * 1024 ** 3,
        maxDurationSeconds: 24 * 3600,
        ocr: { intervalSeconds: 30, maxFrames: 120, maxWidth: 1600 },
      },
    },
  };
  await write(`${token}/${driver}-config.json`, {
    ...config,
    rootDir: undefined,
    storageDir: undefined,
  });
  const rag = await Rag.init(config);
  const modern = typeof rag.listDocuments === "function";
  state.setupMs += performance.now() - startedSetup;
  const roots = [
    ...new Set(files.map((item) => item.relativePath.split("/")[0])),
  ];
  for (const root of roots) await rag.addFolder(root, { hidden: true });
  let active = null;
  let fileStart = performance.now();
  let previousPhases = {};
  const activeStack = [];
  for (
    const [owner, methods] of [[rag._providers, [
      "classify",
      "extract",
      "embed",
      "transcribe",
      "ocr",
      "videoFrames",
    ]], [rag._storage, [modern ? "publish" : "commit"]]]
  ) {
    for (const name of methods) {
      const original = owner[name].bind(owner);
      owner[name] = async (...args) => {
        const started = performance.now();
        const filename = name === "classify" ? args[0] : args[0]?.input?.path;
        if (name === "classify") fileStart = started;
        const info = filename ? fileByPath.get(filename) : null;
        activeStack.push({
          phase: name,
          fileId: info?.id,
          since: new Date().toISOString(),
        });
        active = activeStack.at(-1);
        try {
          return await original(...args);
        } finally {
          phases[name] ??= { calls: 0, ms: 0 };
          phases[name].calls++;
          phases[name].ms += performance.now() - started;
          activeStack.pop();
          active = activeStack.at(-1) ?? null;
        }
      };
    }
  }
  let writingProgress = false;
  const heartbeat = async () => {
    if (writingProgress) return;
    writingProgress = true;
    try {
      await write(`${token}/${driver}-progress.json`, {
        driver,
        completed: completed.size,
        observed: state.records.length,
        total: files.length,
        active,
        phases,
        elapsedIndexMs: state.indexingMs +
          (state.batchStarted ? performance.now() - state.batchStarted : 0),
        memory: Deno.memoryUsage(),
        at: new Date().toISOString(),
      });
    } finally {
      writingProgress = false;
    }
  };
  const interval = setInterval(() => {
    heartbeat().catch((error) => console.error(error.name));
  }, 5000);
  try {
    const ordered = files.slice().sort((a, b) => {
      const first = media.get(a.id), second = media.get(b.id);
      const priority = (item) =>
        /\.pdf$/i.test(item.relativePath)
          ? 0
          : /\.(jpg|jpeg|png)$/i.test(item.relativePath)
          ? 2
          : 1;
      return Number(Boolean(first)) - Number(Boolean(second)) ||
        (first && second
          ? first.durationSeconds - second.durationSeconds
          : priority(a) - priority(b) || a.bytes - b.bytes ||
            a.relativePath.localeCompare(b.relativePath));
    });
    if (modern) {
      const update = rag._update.bind(rag);
      rag._update = async (item) => {
        const started = performance.now();
        const doc = await rag._storage.doc(item.id);
        const info = doc
          ? fileByPath.get(path.resolve(corpusRoot, doc.path))
          : null;
        try {
          return await update(item);
        } finally {
          if (info) {
            state.records.push({
              id: info.id,
              relativePath: info.relativePath,
              bytes: info.bytes,
              wallMs: performance.now() - started,
            });
          }
          await heartbeat();
        }
      };
    }
    const pending = ordered.filter((item) => !completed.has(item.id));
    for (let offset = 0; offset < pending.length;) {
      const size = media.has(pending[offset].id) ? 1 : 25;
      const batch = pending.slice(offset, offset + size);
      offset += batch.length;
      state.batchStarted = performance.now();
      const report = await rag.index({
        scope: { paths: batch.map((item) => item.relativePath) },
        onProgress: modern ? undefined : async (progress) => {
          const item = fileByPath.get(progress.path);
          const stageDelta = Object.fromEntries(
            Object.entries(phases).map((
              [key, value],
            ) => [key, value.ms - (previousPhases[key] ?? 0)]),
          );
          previousPhases = Object.fromEntries(
            Object.entries(phases).map(([key, value]) => [key, value.ms]),
          );
          state.records.push({
            id: item.id,
            relativePath: item.relativePath,
            bytes: item.bytes,
            wallMs: performance.now() - fileStart,
            stagesMs: stageDelta,
          });
          await heartbeat();
        },
      });
      const ms = performance.now() - state.batchStarted;
      state.indexingMs += ms;
      state.batchStarted = null;
      for (const item of batch) completed.add(item.id);
      state.completedIds = [...completed];
      state.batches.push({ files: batch.length, ms, report });
      state.phases = structuredClone(phases);
      state.status = await rag.status();
      state.storageDir = storageDir;
      await write(`${token}/${driver}.json`, state);
      const candidates = [];
      const seen = new Set();
      if (modern) {
        const rows = await rag._storage.locked(() =>
          rag._storage.db.prepare(
            "SELECT d.id AS documentId,d.content_hash AS contentId,d.path,d.mime,c.id AS chunkId,substr(c.text,1,1200) AS text,l.locator FROM docs d JOIN docs_chunks_links l ON l.doc_id=d.id JOIN docs_chunks c ON c.id=l.chunk_id WHERE d.stale=0 AND l.user_meta_id IS NULL AND length(c.text)>=200 ORDER BY d.id,l.ordinal",
          ).all()
        );
        for (const row of rows) {
          if (seen.has(row.chunkId)) continue;
          seen.add(row.chunkId);
          candidates.push({ ...row, locator: JSON.parse(row.locator) });
        }
      } else {for (const document of Object.values(rag._catalog.documents)) {
          if (document.state !== "ready") continue;
          const revision = rag._catalog.revisions[document.revisionId];
          const occurrence = revision.occurrences.find((item) =>
            rag._catalog.chunks[item.chunkId].text.length >= 200
          );
          if (!occurrence || seen.has(occurrence.chunkId)) continue;
          seen.add(occurrence.chunkId);
          candidates.push({
            documentId: document.id,
            contentId: document.contentId,
            path: document.path,
            mime: document.mime,
            chunkId: occurrence.chunkId,
            text: rag._catalog.chunks[occurrence.chunkId].text.slice(0, 1200),
            locator: occurrence.locator,
          });
        }}
      await write(`${token}/${driver}-candidates.json`, candidates);
      console.log(JSON.stringify({
        driver,
        completed: completed.size,
        total: files.length,
        ready: state.status.states.ready ?? 0,
        failed: state.status.states.error ?? 0,
        skipped: state.status.states.skipped ?? 0,
        chunks: state.status.counts.chunks,
        indexingSeconds: state.indexingMs / 1000,
      }));
    }
    state.finishedAt = new Date().toISOString();
    state.status = await rag.status();
    state.emptyReadyDocuments = modern
      ? Number(
        (await rag._storage.locked(() =>
          rag._storage.db.prepare(
            "SELECT COUNT(*) AS n FROM docs d WHERE stale=0 AND NOT EXISTS(SELECT 1 FROM docs_chunks_links l WHERE l.doc_id=d.id AND l.user_meta_id IS NULL)",
          ).get()
        )).n,
      )
      : Object.values(rag._catalog.documents).filter((item) =>
        item.state === "ready" &&
        !rag._catalog.revisions[item.revisionId].occurrences.length
      ).length;
    state.chunkTextCharacters = modern
      ? Number(
        (await rag._storage.locked(() =>
          rag._storage.db.prepare(
            "SELECT COALESCE(SUM(length(text)),0) AS n FROM docs_chunks",
          ).get()
        )).n,
      )
      : Object.values(rag._catalog.chunks).reduce(
        (sum, item) => sum + item.text.length,
        0,
      );
    const unchangedStart = performance.now();
    state.unchanged = await rag.index();
    state.unchangedMs = performance.now() - unchangedStart;
    await write(`${token}/${driver}.json`, state);
    await heartbeat();
  } finally {
    clearInterval(interval);
    await rag.close();
  }
} else if (mode === "run") {
  const token = Deno.args[1] ?? `gpu-${Date.now().toString(36)}`;
  if (!/^[a-z0-9-]+$/.test(token)) throw new Error("Invalid benchmark token");
  const runDir = path.join(directory, token);
  await Deno.mkdir(runDir, { recursive: true });
  await write("current.json", {
    token,
    path: runDir,
    startedAt: new Date().toISOString(),
  });
  for (const driver of ["turso"]) {
    const stdout = await Deno.open(path.join(runDir, `${driver}.stdout.log`), {
      create: true,
      append: true,
      write: true,
    });
    const stderr = await Deno.open(path.join(runDir, `${driver}.stderr.log`), {
      create: true,
      append: true,
      write: true,
    });
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--node-modules-dir=auto",
        "-A",
        import.meta.filename,
        "index",
        driver,
        token,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const timer = setInterval(async () => {
      try {
        const value = JSON.parse(
          await Deno.readTextFile(path.join(runDir, `${driver}-progress.json`)),
        );
        console.log(JSON.stringify({
          driver,
          completed: value.completed,
          observed: value.observed,
          total: value.total,
          phase: value.active?.phase,
          elapsedIndexSeconds: Math.round(value.elapsedIndexMs / 1000),
          rssMiB: Math.round(value.memory.rss / 1024 ** 2),
        }));
      } catch (error) {
        if (
          !(error instanceof Deno.errors.NotFound) &&
          !(error instanceof SyntaxError)
        ) throw error;
      }
    }, 30_000);
    const [status] = await Promise.all([
      child.status,
      child.stdout.pipeTo(stdout.writable),
      child.stderr.pipeTo(stderr.writable),
    ]);
    clearInterval(timer);
    if (!status.success) {
      throw new Error(
        `${driver} full run failed; inspect private stderr log and resume with token ${token}`,
      );
    }
    console.log(JSON.stringify({ driver, stage: "index-complete", token }));
    const search = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--node-modules-dir=auto",
        "-A",
        path.resolve("tests/full-search.js"),
        driver,
        token,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Deno.writeFile(
      path.join(runDir, `${driver}-search.log`),
      new Uint8Array([...search.stdout, ...search.stderr]),
    );
    if (!search.success) {
      throw new Error(
        `${driver} search benchmark failed; inspect private search log`,
      );
    }
  }
  console.log(JSON.stringify({ stage: "turso-index-complete", token }));
  console.log(
    "Current-schema results remain under the private run directory; historical dual-backend publishers are not run.",
  );
} else {throw new Error(
    "Use preflight, run or index; search is tests/full-search.js",
  );}
