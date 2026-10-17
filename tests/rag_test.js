import assert from "node:assert/strict";
import * as path from "node:path";
import process from "node:process";
import { fs, readTextFile, temporaryDirectory } from "./test_runtime.js";
const test = globalThis.Deno?.test ?? (await import("bun:test")).test;
import { Rag } from "../rag.js";

const output = path.resolve("build/core-tests");
await fs.mkdir(output, { recursive: true });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(files, options = {}) {
  const rootDir = await temporaryDirectory({ dir: output, prefix: "native-" });
  await fs.mkdir(path.join(rootDir, "docs/sub"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await fs.writeFile(path.join(rootDir, "docs", name), text);
  }
  const config = {
    rootDir,
    storageDir: ".index",
    ocr: false,
    transcribe: false,
    embedding: false,
    worker: { idleMs: 10, retryMs: 30000 },
    cache: { extractionContext: "content" },
    hookVersion: { extract: "plain-v1", embedding: "words-v1" },
    extract: async ({ input }) => ({
      mime: "text/plain",
      units: [{ text: await readTextFile(input.path) }],
    }),
    ...options,
  };
  const rag = await Rag.init(config);
  await rag.addFolder("docs");
  return {
    rag,
    config,
    rootDir,
    file: (name) => path.join(rootDir, "docs", name),
  };
}

function wordVectors({ texts }) {
  return {
    vectors: texts.map((text) => [
      0.01 + (text.match(/science/gi) ?? []).length,
      0.01 + (text.match(/contract/gi) ?? []).length,
      0.01 + (text.match(/garden/gi) ?? []).length,
    ]),
  };
}

test("native records: dedup, repeated locations, scoped FTS/vector/hybrid, metadata and persistence", async () => {
  let calls = 0;
  let embeddings = 0;
  const f = await fixture({
    "a.txt": "science library",
    "sub/copy.txt": "science library",
    "b.txt": "contract renewal",
  }, {
    extract: async ({ input }) => {
      calls++;
      const text = await readTextFile(input.path);
      return {
        mime: "text/plain",
        units: [1, 2].map((page) => ({
          text,
          language: "it",
          language_source: "detected",
          origin: "native",
          locator: { page },
        })),
      };
    },
    embedding: (request) => {
      embeddings += request.texts.length;
      return wordVectors(request);
    },
  });
  let rag = f.rag;
  try {
    const report = await rag.index();
    assert.equal(report.failed, 0, JSON.stringify(report));
    assert.equal(report.updated, 3);
    assert.equal(calls, 2);
    assert.equal(embeddings, 2);
    const counts = (await rag.status()).counts;
    assert.equal(counts.chunks, 2);
    assert.equal(counts.occurrences, 6);
    assert.equal(counts.extractions, 2);
    for (const mode of ["fulltext", "vector", "hybrid"]) {
      const result = await rag.search("science", { mode, refresh: "none" });
      assert.equal(result.hits[0].text, "science library");
      assert.equal(result.hits[0].citations.length, 4);
      assert.ok(result.hits[0].score > 0);
      const scoped = await rag.search("science", {
        mode,
        refresh: "none",
        limit: 1,
        scope: {
          include: ["docs/b.txt"],
          mime: ["text/*"],
          languages: ["it"],
          origins: ["native"],
        },
      });
      assert.equal(scoped.hits.length, mode === "fulltext" ? 0 : 1);
      if (scoped.hits.length) {
        assert.equal(scoped.hits[0].text, "contract renewal");
      }
    }
    assert.equal(
      (await rag.search("science", { mode: "hybrid", refresh: "none" })).hits[0]
        .score,
      2 / 61,
    );
    assert.equal(
      (await rag.search("science", {
        refresh: "none",
        scope: { languages: ["ru"] },
      })).hits.length,
      0,
    );
    const docs = (await rag.listDocuments()).documents;
    const metadata = await rag.addUserMeta({
      type: "note",
      value: "garden flowers",
      documentIds: docs.slice(0, 2).map((doc) => doc.id),
    });
    assert.equal(
      (await rag.listUserMeta({ query: "flowers" }))[0].id,
      metadata.id,
    );
    const notes = await rag.search("flowers", {
      mode: "hybrid",
      refresh: "wait",
      scope: { kinds: ["note"] },
    });
    assert.equal(notes.freshness.complete, true);
    assert.equal(notes.hits[0].citations.length, 2);
    assert.ok(
      notes.hits[0].citations.every((citation) => citation.origin === "manual"),
    );
    assert.equal(calls, 2, "notes reuse unchanged file extraction");
    await rag.updateUserMeta(metadata.id, { value: "garden blossoms" });
    await rag.search("blossoms", { refresh: "wait", mode: "fulltext" });
    await rag.unlinkUserMeta(docs[0].id, metadata.id);
    const unlinked = await rag.search("blossoms", {
      refresh: "wait",
      mode: "fulltext",
    });
    assert.equal(unlinked.hits[0].citations.length, 1);
    assert.equal((await rag.listUserMeta()).length, 1);
    await assert.rejects(Rag.init(f.config), { code: "STORAGE_LOCKED" });
    await rag.close();
    rag = await Rag.init(f.config);
    assert.equal(
      (await rag.listFolders()).length,
      0,
      "sources are runtime-only",
    );
    assert.equal(
      (await rag.search("blossoms", { refresh: "none", mode: "fulltext" })).hits
        .length,
      1,
    );
    assert.equal("_catalog" in rag, false);
    const names = await rag._storage.locked(() =>
      rag._storage.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all()
    );
    assert.deepEqual(
      names.map((row) => row.name).filter((name) =>
        !name.startsWith("sqlite_") && !name.startsWith("__turso_internal_")
      ),
      [
        "docs",
        "docs_chunks",
        "docs_chunks_links",
        "docs_data",
        "docs_user_meta",
        "user_meta",
      ],
    );
    for (const name of ["catalog.json", "instance.json"]) {
      await assert.rejects(
        fs.stat(path.join(rag.storageDir, name)),
        { code: "ENOENT" },
      );
    }
  } finally {
    await rag.close();
  }
});

test("background search proceeds during extraction; scoped wait promotes only its dependencies", async () => {
  const a = deferred(), b = deferred();
  const order = [];
  const f = await fixture({
    "a.txt": "alpha",
    "b.txt": "beta",
    "z.txt": "zebra",
  }, {
    extract: async ({ input }) => {
      const name = path.basename(input.path);
      order.push(name);
      if (name === "a.txt") await a.promise;
      if (name === "b.txt") await b.promise;
      return {
        mime: "text/plain",
        units: [{ text: await readTextFile(input.path) }],
      };
    },
  });
  try {
    const background = await f.rag.search("alpha", { mode: "fulltext" });
    assert.equal(background.freshness.checked, true);
    assert.equal(background.freshness.staleDetected, 3);
    assert.ok(background.freshness.pending > 0);
    await until(() => order.includes("a.txt"));
    const waiting = f.rag.search("zebra", {
      mode: "fulltext",
      refresh: "wait",
      scope: { paths: ["docs/z.txt"] },
    });
    await until(async () => (await f.rag.status()).worker.prioritized === 1);
    const readable = await f.rag.search("anything", {
      mode: "fulltext",
      refresh: "none",
    });
    assert.equal(readable.freshness.checked, false);
    assert.equal(readable.freshness.complete, null);
    a.resolve();
    const result = await waiting;
    assert.equal(result.freshness.complete, true);
    assert.equal(result.hits[0].text, "zebra");
    assert.equal(
      order[1],
      "z.txt",
      "wait priority precedes unrelated FIFO work",
    );
    assert.ok(
      (await f.rag.status()).counts.stale >= 1,
      "unrelated work need not finish",
    );
    b.resolve();
    await until(async () => (await f.rag.status()).counts.stale === 0);
  } finally {
    a.resolve();
    b.resolve();
    await f.rag.close();
  }
});

test("none does not discover files; stale results remain visible; abort releases scoped priority", async () => {
  let gate;
  const entered = deferred();
  const f = await fixture({ "a.txt": "old garden" }, {
    extract: async ({ input }) => {
      if (gate) {
        entered.resolve();
        await gate.promise;
      }
      return {
        mime: "text/plain",
        units: [{ text: await readTextFile(input.path) }],
      };
    },
  });
  try {
    await f.rag.index();
    await fs.writeFile(f.file("new.txt"), "unknown new document");
    await f.rag.search("unknown", { refresh: "none", mode: "fulltext" });
    assert.equal((await f.rag.status()).counts.documents, 1);
    gate = deferred();
    await fs.writeFile(f.file("a.txt"), "new contract changed");
    const result = await f.rag.search("garden", {
      mode: "fulltext",
      scope: { paths: ["docs/a.txt"] },
    });
    await entered.promise;
    assert.equal(result.hits[0].text, "old garden");
    assert.equal(result.hits[0].citations[0].stale, true);
    const abort = new AbortController();
    const waiting = f.rag.search("contract", {
      mode: "fulltext",
      refresh: "wait",
      scope: { paths: ["docs/a.txt"] },
      signal: abort.signal,
    });
    await until(async () => (await f.rag.status()).worker.prioritized === 1);
    abort.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.equal((await f.rag.status()).worker.prioritized, 0);
    gate.resolve();
    await until(async () => (await f.rag.status()).counts.stale === 0);
    assert.equal(
      (await f.rag.search("contract", { refresh: "none", mode: "fulltext" }))
        .hits[0].text,
      "new contract changed",
    );
  } finally {
    gate?.resolve();
    await f.rag.close();
  }
});

test("idle stale sweep, reopen recovery and independent embedding invalidation", async () => {
  let calls = 0;
  let fail = false;
  const f = await fixture({ "a.txt": "science research" }, {
    embedding: wordVectors,
    extract: async ({ input }) => {
      calls++;
      if (fail) throw new Error("expected fixture failure");
      return {
        mime: "text/plain",
        units: [{ text: await readTextFile(input.path) }],
      };
    },
  });
  let rag = f.rag;
  try {
    await rag.index();
    const doc = (await rag.listDocuments()).documents[0];
    await rag._storage.markStale([doc.id]);
    await until(async () => (await rag.status()).counts.stale === 0);
    assert.equal(calls, 1);
    fail = true;
    await fs.writeFile(f.file("a.txt"), "contract failed revision");
    const failed = await rag.index();
    assert.equal(failed.failed, 1);
    assert.equal(failed.complete, false);
    const before = calls;
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(calls, before, "backoff prevents a stale DB busy retry loop");
    assert.equal(
      (await rag.search("research", { refresh: "none", mode: "fulltext" })).hits
        .length,
      1,
    );
    await rag.close();
    fail = false;
    rag = await Rag.init(f.config);
    await until(async () => (await rag.status()).counts.stale === 0);
    assert.equal((await rag.listFolders()).length, 0);
    assert.equal(
      (await rag.search("failed", { refresh: "none", mode: "fulltext" })).hits
        .length,
      1,
    );
    const extracted = calls;
    await rag.close();
    rag = await Rag.init({
      ...f.config,
      hookVersion: { ...f.config.hookVersion, embedding: "words-v2" },
    });
    await until(async () => (await rag.status()).counts.stale === 0);
    assert.equal(calls, extracted, "model changes reuse extracted artifacts");
    assert.equal(
      (await rag.search("contract", { refresh: "none", mode: "vector" })).hits
        .length,
      1,
    );
    await rag.gc();
    assert.equal((await rag.status()).counts.chunks, 1);
  } finally {
    await rag.close();
  }
});

test("edits during work do not publish obsolete inputs or satisfy scoped waits", async () => {
  const blocked = deferred(), entered = deferred();
  let first = true;
  const f = await fixture({ "a.txt": "original science" }, {
    extract: async ({ input }) => {
      const text = await readTextFile(input.path);
      if (first) {
        first = false;
        entered.resolve();
        await blocked.promise;
      }
      return { mime: "text/plain", units: [{ text }] };
    },
  });
  try {
    await f.rag.search("science", { mode: "fulltext" });
    await entered.promise;
    await fs.writeFile(f.file("a.txt"), "newer contract revision");
    const result = f.rag.search("contract", {
      mode: "fulltext",
      refresh: "wait",
    });
    await until(async () => (await f.rag.status()).worker.queued === 1);
    blocked.resolve();
    const found = await result;
    assert.equal(found.freshness.complete, true);
    assert.equal(found.hits[0].text, "newer contract revision");
    assert.equal(
      (await f.rag.search("science", { refresh: "none", mode: "fulltext" }))
        .hits.length,
      0,
    );
  } finally {
    blocked.resolve();
    await f.rag.close();
  }
});

test("scoped completion rechecks documents edited after another target finishes", async () => {
  const blockedB = deferred(), enteredB = deferred();
  const blockedA = deferred(), enteredA = deferred();
  let revised = false;
  const f = await fixture(
    { "a.txt": "science original", "b.txt": "contract" },
    {
      extract: async ({ input }) => {
        if (path.basename(input.path) === "b.txt") {
          enteredB.resolve();
          await blockedB.promise;
        } else if (revised) {
          enteredA.resolve();
          await blockedA.promise;
        }
        return {
          mime: "text/plain",
          units: [{ text: await readTextFile(input.path) }],
        };
      },
    },
  );
  let settled = false;
  let waiting;
  try {
    waiting = f.rag.search("science", {
      refresh: "wait",
      mode: "fulltext",
    }).then((result) => {
      settled = true;
      return result;
    });
    await enteredB.promise;
    revised = true;
    await fs.writeFile(f.file("a.txt"), "science revised document");
    await f.rag.search("science", {
      mode: "fulltext",
      scope: { paths: ["docs/a.txt"] },
    });
    blockedB.resolve();
    await enteredA.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      settled,
      false,
      "the earlier completion cannot satisfy the newer revision",
    );
    blockedA.resolve();
    const result = await waiting;
    assert.equal(result.freshness.complete, true);
    assert.equal(result.hits[0].text, "science revised document");
  } finally {
    blockedA.resolve();
    blockedB.resolve();
    await waiting?.catch(() => {});
    await f.rag.close();
  }
});

test("an edited active document rejoins FIFO behind already queued documents", async () => {
  const entered = deferred(), release = deferred();
  const order = [];
  const f = await fixture({ "a.txt": "science initial", "b.txt": "contract" }, {
    extract: async ({ input }) => {
      const name = path.basename(input.path);
      order.push(name);
      const text = await readTextFile(input.path);
      if (order.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return { mime: "text/plain", units: [{ text }] };
    },
  });
  let indexing;
  try {
    indexing = f.rag.index();
    await entered.promise;
    await fs.writeFile(f.file("a.txt"), "science revised content");
    await f.rag.search("science", {
      mode: "fulltext",
      scope: { paths: ["docs/a.txt"] },
    });
    release.resolve();
    assert.equal((await indexing).complete, true);
    assert.deepEqual(order, ["a.txt", "b.txt", "a.txt"]);
  } finally {
    release.resolve();
    await indexing?.catch(() => {});
    await f.rag.close();
  }
});

test("removing a source completes its scoped wait before obsolete extraction ends", async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ "a.txt": "science" }, {
    extract: async () => {
      entered.resolve();
      await release.promise;
      return { mime: "text/plain", units: [{ text: "science" }] };
    },
  });
  let waiting;
  try {
    waiting = f.rag.search("science", {
      mode: "fulltext",
      refresh: "wait",
      scope: { paths: ["docs/a.txt"] },
    });
    await entered.promise;
    const [source] = await f.rag.listFolders();
    await f.rag.removeFolder(source.id);
    const found = await waiting;
    assert.deepEqual(found.hits, []);
    assert.equal(found.freshness.complete, true);
    assert.equal(found.refresh.removed, 1);
    assert.equal((await f.rag.status()).worker.prioritized, 0);
  } finally {
    release.resolve();
    await waiting?.catch(() => {});
    await f.rag.close();
  }
});

test("limits and errors terminate waits without starving other documents", async () => {
  let calls = 0;
  const f = await fixture({
    "a.txt": "this file is too large",
    "b.txt": "ok",
    "c.txt": "bad",
  }, {
    indexing: { maxFileBytes: 4 },
    extract: async ({ input }) => {
      calls++;
      if (input.path.endsWith("c.txt")) {
        throw new Error("expected parser failure");
      }
      return {
        mime: "text/plain",
        units: [{ text: await readTextFile(input.path) }],
      };
    },
  });
  try {
    const result = await f.rag.search("ok", {
      mode: "fulltext",
      refresh: "wait",
    });
    assert.equal(result.refresh.skipped, 1);
    assert.equal(result.refresh.failed, 1);
    assert.equal(result.freshness.complete, false);
    assert.equal(result.hits[0].text, "ok");
    assert.equal(
      calls,
      2,
      "byte rejection happens before extraction/model work",
    );
  } finally {
    await f.rag.close();
  }
});

test("overlapping runtime folders, scoped deletion and metadata preservation", async () => {
  const f = await fixture({
    "a.txt": "outer astronomy",
    "sub/b.txt": "inner astronomy",
  });
  try {
    const outer = (await f.rag.listFolders())[0];
    const inner = await f.rag.addFolder("docs/sub");
    await f.rag.index();
    const doc =
      (await f.rag.listDocuments({ scope: { paths: ["docs/sub/b.txt"] } }))
        .documents[0];
    const meta = await f.rag.addUserMeta({
      value: "user keeps this",
      documentIds: [doc.id],
    });
    await f.rag.search("astronomy", { refresh: "wait", mode: "fulltext" });
    await f.rag.removeFolder(outer.id);
    assert.equal((await f.rag.status()).counts.documents, 1);
    assert.equal(
      (await f.rag.search("astronomy", { refresh: "none", mode: "fulltext" }))
        .hits[0].citations.length,
      1,
    );
    await f.rag.removeFolder(inner.id);
    await until(async () => {
      const { worker } = await f.rag.status();
      return !worker.active && !worker.queued;
    });
    await f.rag.gc();
    assert.equal((await f.rag.status()).counts.documents, 0);
    assert.equal((await f.rag.listUserMeta())[0].id, meta.id);
  } finally {
    await f.rag.close();
  }
});

test("incomplete traversal cannot prune; confirmed absence is reconciled later", async () => {
  const f = await fixture({ "a.txt": "science remains" });
  const readDir = fs.opendir;
  try {
    await f.rag.index();
    await fs.rm(f.file("a.txt"));
    fs.opendir = (directory) => {
      if (directory === path.join(f.rootDir, "docs")) {
        throw Object.assign(new Error("fixture traversal denial"), {
          code: "EACCES",
        });
      }
      return readDir(directory);
    };
    const partial = await f.rag.index();
    assert.equal(partial.complete, false);
    assert.equal((await f.rag.status()).counts.documents, 1);
    fs.opendir = readDir;
    assert.equal((await f.rag.index()).removed, 1);
    assert.equal((await f.rag.status()).counts.documents, 0);
  } finally {
    fs.opendir = readDir;
    await f.rag.close();
  }
});

test("watch uses the same worker, handles new/changed/deleted files and closes cleanly", async () => {
  const f = await fixture({ "a.txt": "old science" });
  let watcher;
  try {
    await f.rag.index();
    watcher = await f.rag.watch({ debounceMs: 10 });
    await assert.rejects(f.rag.watch(), { code: "ALREADY_WATCHING" });
    await fs.writeFile(f.file("a.txt"), "new garden text");
    await until(async () =>
      (await f.rag.search("garden", { refresh: "none", mode: "fulltext" })).hits
        .length === 1
    );
    await fs.writeFile(f.file("b.txt"), "new contract text");
    await until(async () =>
      (await f.rag.status()).counts.documents === 2 &&
      (await f.rag.status()).counts.stale === 0
    );
    await fs.rm(f.file("b.txt"));
    await until(async () => (await f.rag.status()).counts.documents === 1);
    await watcher.close();
    await watcher.close();
  } finally {
    await watcher?.close();
    await f.rag.close();
  }
});

test("hash verification detects preserved metadata; reindex layers reuse unaffected work", async () => {
  let calls = 0, embedded = 0;
  const f = await fixture({ "a.txt": "science", "sub/b.txt": "science" }, {
    embedding: (request) => {
      embedded += request.texts.length;
      return wordVectors(request);
    },
    extract: async ({ input }) => {
      calls++;
      return {
        mime: "text/plain",
        units: [{ text: await readTextFile(input.path) }],
      };
    },
  });
  try {
    await f.rag.index();
    await f.rag.reindex({ from: "chunks" });
    assert.equal(calls, 1);
    assert.equal(embedded, 1);
    await f.rag.reindex({ from: "embeddings" });
    assert.equal(calls, 1);
    assert.equal(embedded, 2);
    await f.rag.reindex({ from: "extract" });
    assert.equal(calls, 2);
    assert.equal(embedded, 2);
    await f.rag.reindex({ from: "indexes" });
    assert.ok(
      (await f.rag.search("science", { refresh: "none", mode: "fulltext" }))
        .hits[0].score > 0,
    );
    const stat = await fs.stat(f.file("a.txt"));
    await fs.writeFile(f.file("a.txt"), "garden ");
    await fs.utimes(f.file("a.txt"), stat.atime, stat.mtime);
    assert.equal((await f.rag.index()).updated, 0);
    const exact = await f.rag.index({ verify: "hash" });
    assert.equal(exact.updated, 1);
  } finally {
    await f.rag.close();
  }
});

test("legacy stores and removed drivers are rejected without altering old data", async () => {
  const rootDir = await temporaryDirectory({ dir: output, prefix: "legacy-" });
  await fs.writeFile(
    path.join(rootDir, "instance.json"),
    "old untouched input",
  );
  await assert.rejects(Rag.init({ storageDir: rootDir }), {
    code: "LEGACY_STORAGE",
  });
  assert.equal(
    await readTextFile(path.join(rootDir, "instance.json")),
    "old untouched input",
  );
  await assert.rejects(
    Rag.init({ storageDir: rootDir, storage: { driver: "lancedb" } }),
    TypeError,
  );
});

test("publication rollback preserves complete prior links, vectors and full-text hits", async () => {
  const f = await fixture({ "a.txt": "science before" }, {
    embedding: wordVectors,
  });
  const db = f.rag._storage.db;
  const transactionAsync = db.transactionAsync;
  try {
    await f.rag.index();
    db.transactionAsync = function (operation) {
      return transactionAsync.call(this, async (tx) => {
        await operation(tx);
        throw new Error("fixture failure after publication writes");
      });
    };
    await fs.writeFile(f.file("a.txt"), "contract after rollback");
    const failed = await f.rag.index();
    assert.equal(failed.failed, 1);
    db.transactionAsync = transactionAsync;
    for (const mode of ["fulltext", "vector", "hybrid"]) {
      const old = await f.rag.search("science", { mode, refresh: "none" });
      assert.equal(old.hits[0].text, "science before");
      assert.equal(old.hits[0].citations[0].stale, true);
    }
    assert.equal(
      (await f.rag.search("rollback", { mode: "fulltext", refresh: "none" }))
        .hits.length,
      0,
    );
    assert.equal((await f.rag.index()).failed, 0);
    assert.equal(
      (await f.rag.search("rollback", { mode: "fulltext", refresh: "none" }))
        .hits[0].text,
      "contract after rollback",
    );
  } finally {
    db.transactionAsync = transactionAsync;
    await f.rag.close();
  }
});

test("overlapping waiters retain priority until the last interested request leaves", async () => {
  const gate = deferred(), entered = deferred();
  const f = await fixture({ "a.txt": "science" }, {
    extract: async () => {
      entered.resolve();
      await gate.promise;
      return { mime: "text/plain", units: [{ text: "science" }] };
    },
  });
  try {
    await f.rag.search("science", { mode: "fulltext" });
    await entered.promise;
    const cancel = new AbortController();
    const first = f.rag.search("science", {
      refresh: "wait",
      mode: "fulltext",
      signal: cancel.signal,
    });
    const second = f.rag.search("science", {
      refresh: "wait",
      mode: "fulltext",
    });
    await until(() =>
      [...f.rag._states.values()].some((state) => state.priority === 2)
    );
    cancel.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(
      [...f.rag._states.values()].filter((state) => state.priority).length,
      1,
    );
    assert.equal(
      [...f.rag._states.values()].find((state) => state.priority).priority,
      1,
    );
    gate.resolve();
    assert.equal((await second).freshness.complete, true);
    assert.equal((await f.rag.status()).worker.prioritized, 0);
  } finally {
    gate.resolve();
    await f.rag.close();
  }
});

test("concurrent scoped queries isolate temporary native scope and metadata filters", async () => {
  const f = await fixture({
    "a.txt": "science astronomy",
    "b.txt": "contract signatures",
  }, { embedding: wordVectors });
  try {
    await f.rag.index();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const name = index % 2 ? "a.txt" : "b.txt";
      return f.rag.search("science contract", {
        mode: "hybrid",
        refresh: "none",
        limit: 1,
        scope: { paths: ["docs/" + name] },
      })
        .then((result) => ({ name, result }));
    }));
    for (const { name, result } of results) {
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0].citations.length, 1);
      assert.ok(result.hits[0].citations[0].path.endsWith(name));
    }
  } finally {
    await f.rag.close();
  }
});

test("UTF-8 citations and exact paths avoid unrelated filesystem traversal", async () => {
  const text = "😀 scienza\nseconda frase unico";
  const f = await fixture({ "literal[1].txt": text, "b.txt": "unrelated" }, {
    chunking: { maxCharacters: 12, overlap: 2 },
  });
  const readDir = fs.opendir;
  try {
    fs.opendir = () => {
      throw new Error("Exact paths must not traverse the source tree");
    };
    const result = await f.rag.search("scienza frase unico", {
      mode: "fulltext",
      refresh: "wait",
      scope: { paths: ["docs/literal[1].txt"] },
    });
    assert.equal(result.freshness.complete, true);
    assert.ok(result.hits.length >= 2);
    const bytes = new TextEncoder().encode(text);
    for (const hit of result.hits) {
      for (const citation of hit.citations) {
        assert.equal(
          new TextDecoder().decode(bytes.slice(citation.start, citation.end)),
          hit.text,
        );
        assert.equal(citation.offsetUnit, "utf8-bytes");
      }
    }
    assert.equal((await f.rag.status()).counts.documents, 1);
  } finally {
    fs.opendir = readDir;
    await f.rag.close();
  }
});

test("instances isolate roots, storage, source configuration and direct hooks", async () => {
  const cwd = process.cwd();
  const first = await fixture({ "a.txt": "science first instance" });
  const second = await fixture({ "a.txt": "garden second instance" }, {
    ocr: (request) => ({
      text: "direct OCR",
      provider: "fixture",
      filename: request.input.filename,
    }),
    transcribe: () => ({
      text: "trascrizione originale",
      language: "it",
      segments: [],
    }),
  });
  try {
    await Promise.all([first.rag.index(), second.rag.index()]);
    assert.equal(process.cwd(), cwd);
    assert.equal(
      (await first.rag.search("garden", { refresh: "none", mode: "fulltext" }))
        .hits.length,
      0,
    );
    assert.equal(
      (await second.rag.search("garden", { refresh: "none", mode: "fulltext" }))
        .hits.length,
      1,
    );
    const before = (await second.rag.status()).counts.documents;
    assert.equal(
      (await second.rag.transcribe({
        bytes: new Uint8Array([1]),
        filename: "clip.wav",
      })).text,
      "trascrizione originale",
    );
    assert.equal(
      (await second.rag.ocr({
        bytes: new Uint8Array([1]),
        filename: "image.png",
        mime: "image/png",
      })).text,
      "direct OCR",
    );
    assert.equal((await second.rag.status()).counts.documents, before);
    await first.rag.close();
    assert.equal(
      (await second.rag.search("garden", { refresh: "none", mode: "fulltext" }))
        .hits.length,
      1,
    );
  } finally {
    await first.rag.close();
    await second.rag.close();
  }
});

test("close rejects scoped waiters and preserves interrupted pending work for reopen", async () => {
  const gate = deferred(), entered = deferred();
  const f = await fixture({ "a.txt": "science" }, {
    extract: async () => {
      entered.resolve();
      await gate.promise;
      return { mime: "text/plain", units: [{ text: "science" }] };
    },
  });
  let rag = f.rag;
  try {
    const waiting = rag.search("science", {
      refresh: "wait",
      mode: "fulltext",
    });
    await entered.promise;
    const rejection = assert.rejects(waiting, { code: "CLOSED" });
    const closing = rag.close();
    await rejection;
    await assert.rejects(rag.status(), { code: "CLOSED" });
    gate.resolve();
    await closing;
    rag = await Rag.init(f.config);
    await until(async () => (await rag.status()).counts.stale === 0);
    assert.equal(
      (await rag.search("science", { refresh: "none", mode: "fulltext" })).hits
        .length,
      1,
    );
  } finally {
    gate.resolve();
    await rag.close();
  }
});

test("empty document scope returns without query model work", async () => {
  let calls = 0;
  const f = await fixture({ "a.txt": "science" }, {
    embedding: (request) => {
      calls++;
      return wordVectors(request);
    },
  });
  try {
    await f.rag.index();
    const before = calls;
    for (const mode of ["fulltext", "vector", "hybrid"]) {
      const result = await f.rag.search("science", {
        mode,
        refresh: "none",
        scope: { paths: [] },
      });
      assert.deepEqual(result.hits, []);
    }
    assert.equal(calls, before);
  } finally {
    await f.rag.close();
  }
});

test("unknown MIME in a checked scope remains pending until extraction identifies it", async () => {
  const gate = deferred(), entered = deferred();
  const f = await fixture({ "a.bin": "unclassified fixture" }, {
    extract: async () => {
      entered.resolve();
      await gate.promise;
      return {
        mime: "application/pdf",
        units: [{ text: "identified PDF text" }],
      };
    },
  });
  try {
    const result = await f.rag.search("identified", {
      mode: "fulltext",
      scope: { mime: ["application/pdf"] },
    });
    await entered.promise;
    assert.equal(result.freshness.staleDetected, 1);
    assert.equal(result.freshness.pending, 1);
    assert.equal(result.freshness.complete, false);
    gate.resolve();
    const updated = await f.rag.search("identified", {
      mode: "fulltext",
      refresh: "wait",
      scope: { mime: ["application/pdf"] },
    });
    assert.equal(updated.freshness.complete, true);
    assert.equal(updated.hits.length, 1);
  } finally {
    gate.resolve();
    await f.rag.close();
  }
});

test("persistent embedding descriptors do not copy arbitrary provider options", async () => {
  const f = await fixture({ "a.txt": "science" }, {
    embedding: {
      model: "multilingual",
      apiKey: "fixture-secret-not-for-storage",
    },
  });
  try {
    f.rag._providers.embed = (texts) => wordVectors({ texts });
    await f.rag.index();
    const rows = await f.rag._storage.locked(() =>
      f.rag._storage.db.prepare("SELECT embedding_config FROM docs_chunks")
        .all()
    );
    assert.ok(rows.length);
    assert.ok(!JSON.stringify(rows).includes("fixture-secret-not-for-storage"));
    assert.equal(JSON.parse(rows[0].embedding_config).model, "multilingual");
  } finally {
    await f.rag.close();
  }
});

test("repeated metadata/hash refreshes share one active extraction", async () => {
  const gate = deferred(), entered = deferred();
  let calls = 0;
  const f = await fixture({ "a.txt": "science" }, {
    extract: async () => {
      calls++;
      entered.resolve();
      await gate.promise;
      return { mime: "text/plain", units: [{ text: "science" }] };
    },
  });
  try {
    await f.rag.search("science", { mode: "fulltext" });
    await entered.promise;
    const token = f.rag._active.token;
    for (const verify of ["metadata", "metadata", "hash", "hash"]) {
      await f.rag.search("science", { mode: "fulltext", verify });
      assert.equal(f.rag._active.token, token);
      assert.equal(f.rag._state(f.rag._active.id).token, token);
      assert.equal(f.rag._queue.size, 0);
    }
    const indexed = f.rag.index();
    const waited = f.rag.search("science", {
      mode: "fulltext",
      refresh: "wait",
    });
    await until(async () => (await f.rag.status()).worker.prioritized === 1);
    assert.equal(f.rag._state(f.rag._active.id).token, token);
    gate.resolve();
    assert.equal((await waited).freshness.complete, true);
    await indexed;
    assert.equal(calls, 1);
  } finally {
    gate.resolve();
    await f.rag.close();
  }
});

test("watching the root excludes nested storage without a publication feedback loop", async () => {
  const f = await fixture({ "a.txt": "initial science" });
  let watch;
  try {
    await f.rag.addFolder(".");
    await f.rag.index();
    let publications = 0;
    const publish = f.rag._storage.publish.bind(f.rag._storage);
    f.rag._storage.publish = (...args) => {
      publications++;
      return publish(...args);
    };
    watch = await f.rag.watch({ debounceMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(publications, 0);
    await fs.writeFile(f.file("a.txt"), "updated garden");
    await until(async () =>
      (await f.rag.search("garden", { mode: "fulltext", refresh: "none" })).hits
        .length === 1
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      publications <= 3,
      "storage changes must not keep rescheduling ingestion",
    );
    assert.equal((await f.rag.status()).worker.queued, 0);
  } finally {
    await watch?.close();
    await f.rag.close();
  }
});

test("native scoped FTS preserves scores and expands citations only for final hits", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `${index}.txt`,
      `science library record${index} ${"details ".repeat(index)}`,
    ]),
  );
  const f = await fixture(files, {
    embedding: wordVectors,
    extract: ({ input }) => ({
      mime: "text/plain",
      units: [1, 2, 3].map((page) => ({
        text: files[path.basename(input.path)],
        origin: "native",
        language: "it",
        locator: { page },
      })),
    }),
  });
  try {
    await f.rag.index();
    const db = f.rag._storage.db;
    const prepare = db.prepare.bind(db);
    let expanded = [];
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.includes("SELECT l.*,d.path")) {
        const all = statement.all.bind(statement);
        statement.all = async (...args) => {
          const rows = await all(...args);
          expanded.push(...rows.map((row) => row.chunk_id));
          return rows;
        };
      }
      return statement;
    };
    const reference = await f.rag.search("science", {
      mode: "fulltext",
      refresh: "none",
      limit: 100,
    });
    const target = reference.hits.at(-1);
    const scoped = await f.rag.search("science", {
      mode: "fulltext",
      refresh: "none",
      limit: 1,
      scope: {
        paths: [target.citations[0].relativePath],
        languages: ["it"],
        origins: ["native"],
        kinds: ["text"],
      },
    });
    assert.equal(scoped.hits[0].chunkId, target.chunkId);
    assert.equal(scoped.hits[0].score, target.score);
    assert.ok(target.score > 0);
    const fusion = new Map();
    for (const mode of ["fulltext", "vector"]) {
      const branch = await f.rag.search("science library", {
        mode,
        refresh: "none",
        limit: 4,
      });
      branch.hits.forEach((hit, rank) =>
        fusion.set(
          hit.chunkId,
          (fusion.get(hit.chunkId) ?? 0) + 1 / (61 + rank),
        )
      );
    }
    const expected = [...fusion].sort((a, b) =>
      b[1] - a[1] || a[0].localeCompare(b[0])
    )[0];
    const hybrid = await f.rag.search("science library", {
      mode: "hybrid",
      refresh: "none",
      limit: 1,
    });
    assert.equal(hybrid.hits[0].chunkId, expected[0]);
    assert.equal(hybrid.hits[0].score, expected[1]);
    for (const mode of ["fulltext", "vector", "hybrid"]) {
      expanded = [];
      const response = await f.rag.search("science", {
        mode,
        refresh: "none",
        limit: 1,
      });
      assert.deepEqual([...new Set(expanded)], [response.hits[0].chunkId]);
      assert.equal(
        expanded.length,
        3,
        "discarded candidates need no citations",
      );
    }
    const docs = (await f.rag.listDocuments()).documents;
    const note = await f.rag.addUserMeta({
      type: "note",
      value: "science research",
      documentIds: [docs[0].id],
    });
    await f.rag.addUserMeta({
      type: "tag",
      value: "science science library",
      documentIds: [docs[1].id],
    });
    const all = await f.rag.listUserMeta({ query: "science" });
    const linked = await f.rag.listUserMeta({
      query: "science",
      documentId: docs[0].id,
      type: "note",
    });
    assert.deepEqual(linked, all.filter((row) => row.id === note.id));
    await f.rag.index();
    await f.rag.updateUserMeta(note.id, { value: "garden flowers" });
    await f.rag.index();
    const before = (await f.rag.status()).counts.chunks;
    const collected = await f.rag.gc();
    const after = (await f.rag.status()).counts.chunks;
    assert.equal(collected.chunksRemoved, before - after);
    assert.ok(collected.chunksRemoved > 0);
  } finally {
    await f.rag.close();
  }
});

test("glob selection preserves hidden files, braces, globstar and absolute paths on both runtimes", async () => {
  const f = await fixture({
    "a.txt": "shared science",
    "b.md": "shared science",
    ".hidden.txt": "shared science",
    "sub/c.txt": "shared science",
    "sub/d.md": "shared science",
  });
  try {
    await f.rag.index();
    assert.equal((await f.rag.status()).counts.documents, 4);
    await f.rag.addFolder("docs", { hidden: true });
    await f.rag.index();
    for (
      const [include, exclude, expected] of [
        [["docs/**/*.{txt,md}"], [], 5],
        [["docs/*.txt"], [], 2],
        [["docs/**/[ac].txt"], [], 2],
        [["docs/**/?.md"], [], 2],
        [["docs/**/*.txt"], ["docs/sub/**"], 2],
        [[f.file("sub/*.txt")], [], 1],
      ]
    ) {
      const result = await f.rag.search("science", {
        mode: "fulltext",
        refresh: "none",
        scope: { include, exclude },
      });
      assert.equal(
        result.hits[0]?.citations.length,
        expected,
        JSON.stringify(include),
      );
    }
  } finally {
    await f.rag.close();
  }
});

test("operation lifetimes drain queued direct hooks and release failures before close", async () => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const f = await fixture({}, {
    ocr: async () => {
      calls++;
      if (calls === 1) {
        await assert.rejects(f.rag.status(), { code: "REENTRANT_CALL" });
        entered.resolve();
        await release.promise;
        return { text: "direct result" };
      }
      throw new Error("queued hook failure");
    },
  });
  try {
    const input = { bytes: new Uint8Array([1]), filename: "fixture.png" };
    const first = f.rag.ocr(input);
    await entered.promise;
    const second = assert.rejects(f.rag.ocr(input), /queued hook failure/);
    const closing = f.rag.close();
    await assert.rejects(f.rag.status(), { code: "CLOSED" });
    release.resolve();
    assert.equal((await first).text, "direct result");
    await second;
    await closing;
    assert.equal(calls, 2);
    assert.equal(f.rag._operations.size, 0);
    await assert.rejects(f.rag.listUserMeta(), { code: "CLOSED" });
  } finally {
    release.resolve();
    await f.rag.close();
  }
});
