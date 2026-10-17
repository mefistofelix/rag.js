/**
 * Local RAG for Deno and Bun. One distributable module, optional native providers.
 * Layers: values/policies -> storage adapters -> content providers -> Rag.
 * No filesystem, native binding or model initialization occurs at import time.
 */
import * as path from "node:path";
import fs from "node:fs/promises";
import {
  createReadStream,
  createWriteStream,
  watch as watchDirectory,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// A data module enters Deno's resolver even when this file lives in an npm package.
const importDeno = (specifier) =>
  import(
    "data:text/javascript," +
      encodeURIComponent("export * from " + JSON.stringify(specifier) + ";")
  );
const importNpm = (specifier) =>
  globalThis.Bun ? import(specifier) : importDeno("npm:" + specifier);

// Native providers stay lazy in both standalone and installed use.
const imports = {
  turso: () => importNpm("@tursodatabase/database@0.8.3"),
  xberg: () => importNpm("@xberg-io/xberg@1.3.10"),
  av: () => importNpm("node-av@6.1.1"),
  auto: () => importNpm("@mefistofelix/auto.js@0.1.5"),
  glob: () => importDeno("jsr:@std/path@1.1.6/posix/glob-to-regexp"),
};

export const VERSION = "0.3.0";
const MiB = 1024 * 1024;
const encoder = new TextEncoder();

export class RagError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "RagError";
    this.code = code;
  }
}

class SkipFile extends RagError {}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function hash(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : JSON.stringify(canonical(value));
  return createHash("sha256").update(bytes).digest("hex");
}

function localPath(value, root) {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new TypeError("Only file: URLs are accepted");
    }
    return fileURLToPath(value);
  }
  if (typeof value !== "string") {
    throw new TypeError("Expected a local path or file: URL");
  }
  if (value.startsWith("file:")) return fileURLToPath(value);
  if (/^[a-z]+:\/\//i.test(value)) {
    throw new TypeError("Remote URLs are not local files");
  }
  return path.resolve(root, value);
}

function inside(filename, directory) {
  const relative = path.relative(directory, filename);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." &&
      !path.isAbsolute(relative));
}

function slash(value) {
  return value.replaceAll("\\", "/");
}

function checkedNumber(value, name, { min = 0, integer = false } = {}) {
  if (
    !Number.isFinite(value) || value < min ||
    (integer && !Number.isInteger(value))
  ) {
    throw new TypeError(
      `${name} must be ${integer ? "an integer" : "finite"} >= ${min}`,
    );
  }
  return value;
}

function stringList(value, name) {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value;
}

function checkSignal(signal) {
  signal?.throwIfAborted();
}

function errorInfo(error) {
  return { code: error.code ?? error.name, message: error.message };
}

async function hashFile(filename, signal) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(filename, { signal })) {
    checkSignal(signal);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

async function optional(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!(error.code === "ENOENT")) throw error;
  }
}

async function download(url, filename, { signal, sha256 } = {}) {
  const cached = await optional(() => fs.stat(filename));
  if (cached?.size > 0) {
    if (sha256 && await hashFile(filename, signal) !== sha256) {
      throw new RagError(
        "MODEL_CHECKSUM",
        `Checksum mismatch: ${path.basename(filename)}`,
      );
    }
    return filename;
  }
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.part`;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new RagError(
        "DOWNLOAD",
        `Model download failed (${response.status})`,
      );
    }
    await pipeline(
      response.body,
      createWriteStream(temporary, { flags: "wx" }),
      { signal },
    );
    if (sha256 && await hashFile(temporary, signal) !== sha256) {
      throw new RagError(
        "MODEL_CHECKSUM",
        `Checksum mismatch: ${path.basename(filename)}`,
      );
    }
    await fs.rename(temporary, filename);
  } finally {
    await optional(() => fs.rm(temporary));
  }
  return filename;
}

function limitsFrom(options = {}) {
  const video = options.video ?? {};
  const result = {
    maxFileBytes: options.maxFileBytes ?? 64 * MiB,
    audio: {
      maxFileBytes: options.audio?.maxFileBytes ?? 256 * MiB,
      maxDurationSeconds: options.audio?.maxDurationSeconds ?? 7200,
    },
    video: {
      maxFileBytes: video.maxFileBytes ?? 1024 * MiB,
      maxDurationSeconds: video.maxDurationSeconds ?? 7200,
      transcribe: video.transcribe ?? true,
      ocr: video.ocr === false ? false : {
        intervalSeconds: video.ocr?.intervalSeconds ?? 30,
        maxFrames: video.ocr?.maxFrames ?? 120,
        maxWidth: video.ocr?.maxWidth ?? 1600,
      },
    },
    maxPages: options.maxPages ?? 500,
    maxArchiveBytes: options.maxArchiveBytes ?? 256 * MiB,
    maxArchiveEntries: options.maxArchiveEntries ?? 1000,
    maxArchiveDepth: options.maxArchiveDepth ?? 3,
  };
  checkedNumber(result.maxFileBytes, "indexing.maxFileBytes", { min: 1 });
  for (const type of ["audio", "video"]) {
    checkedNumber(result[type].maxFileBytes, `indexing.${type}.maxFileBytes`, {
      min: 1,
    });
    checkedNumber(
      result[type].maxDurationSeconds,
      `indexing.${type}.maxDurationSeconds`,
      { min: 0.001 },
    );
  }
  for (
    const key of [
      "maxPages",
      "maxArchiveBytes",
      "maxArchiveEntries",
      "maxArchiveDepth",
    ]
  ) {
    checkedNumber(result[key], `indexing.${key}`, { min: 1, integer: true });
  }
  if (result.video.ocr) {
    checkedNumber(
      result.video.ocr.intervalSeconds,
      "video.ocr.intervalSeconds",
      { min: 0.001 },
    );
    checkedNumber(result.video.ocr.maxFrames, "video.ocr.maxFrames", {
      min: 1,
      integer: true,
    });
    checkedNumber(result.video.ocr.maxWidth, "video.ocr.maxWidth", {
      min: 32,
      integer: true,
    });
  }
  return result;
}

class Selection {
  constructor(root, options, globToRegExp) {
    for (const name of ["sourceIds", "paths", "include", "exclude", "mime"]) {
      stringList(options?.[name], `scope.${name}`);
    }
    this.root = root;
    this.sourceIds = options?.sourceIds;
    this.paths = options?.paths
      ? new Set(options.paths.map((value) => localPath(value, root)))
      : null;
    this.mime = options?.mime;
    const compile = (patterns = []) =>
      patterns.map((pattern) => {
        const absolute = path.isAbsolute(pattern);
        return {
          absolute,
          regex: globToRegExp(slash(pattern), { globstar: true }),
        };
      });
    this.include = compile(options?.include);
    this.exclude = compile(options?.exclude);
  }

  pathMatches(filename) {
    if (this.paths && !this.paths.has(filename)) return false;
    const matches = (pattern) =>
      pattern.regex.test(
        pattern.absolute
          ? slash(filename)
          : slash(path.relative(this.root, filename)),
      );
    return (!this.include.length || this.include.some(matches)) &&
      !this.exclude.some(matches);
  }

  mimeMatches(mime) {
    return !this.mime?.length ||
      this.mime.some((pattern) =>
        pattern.endsWith("/*")
          ? mime?.startsWith(pattern.slice(0, -1))
          : mime === pattern
      );
  }
}

function splitText(text, { maxCharacters, overlap }) {
  const characters = Array.from(text.replace(/\r\n?/g, "\n"));
  const offsets = [0];
  for (const character of characters) {
    offsets.push(offsets.at(-1) + encoder.encode(character).length);
  }
  const chunks = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(characters.length, start + maxCharacters);
    if (end < characters.length) {
      for (
        let i = end;
        i > start + Math.max(overlap + 1, Math.floor(maxCharacters / 2));
        i--
      ) {
        if (/\s/u.test(characters[i - 1])) {
          end = i;
          break;
        }
      }
    }
    const content = characters.slice(start, end).join("");
    if (content.trim()) {
      chunks.push({ text: content, start: offsets[start], end: offsets[end] });
    }
    if (end === characters.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function vectorsChecked(vectors, count, dimensions) {
  if (!Array.isArray(vectors) || vectors.length !== count) {
    throw new TypeError("Embedding count does not match input count");
  }
  let expected = dimensions;
  return vectors.map((vector) => {
    const values = Array.from(vector);
    expected ??= values.length;
    if (
      !values.length || values.length !== expected || values.some((v) =>
        !Number.isFinite(v)
      ) || !values.some((v) => v !== 0)
    ) {
      throw new TypeError(
        "Embeddings must be finite, nonzero vectors of consistent dimensions",
      );
    }
    return values;
  });
}

function groups(values, size = 250) {
  const result = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

function fullTextQuery(query) {
  return searchTerms(query).map((term) => `"${term}"`).join(" OR ");
}

function searchTerms(query) {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) {
    throw new TypeError("Search query must contain letters or numbers");
  }
  return terms;
}

function byScore(a, b) {
  return b.score - a.score || a.id.localeCompare(b.id);
}

function rankResults(branches, mode, limit) {
  const scores = new Map();
  for (const branch of branches) {
    for (
      const [rank, item] of branch.sort(byScore).slice(0, limit * 4).entries()
    ) {
      const result = scores.get(item.id) ?? { id: item.id, score: 0 };
      result.score += mode === "hybrid" ? 1 / (61 + rank) : item.score;
      scores.set(item.id, result);
    }
  }
  return [...scores.values()].sort(byScore).slice(0, limit);
}

// Storage owns SQL, native vectors and short connection/transaction locks.
// Every table contains individual records. There is no persistent runtime catalog.
class TursoStorage {
  statement(method, sql, ...args) {
    return this.locked(() => this.db.prepare(sql)[method](...args));
  }

  transaction(operation) {
    return this.locked(() => this.db.transactionAsync(operation)());
  }

  async insert(
    db,
    table,
    columns,
    rows,
    { ignore = false, conflict = "" } = {},
  ) {
    const fields = columns.split(" ");
    const json = new Set([
      "vector",
      "structure",
      "metadata",
      "languages",
      "warnings",
      "locator",
      "embedding_config",
    ]);
    for (const batch of groups(rows, 100)) {
      const marks = batch.map((row) =>
        `(${
          fields.map((field) =>
            field === "vector" && row.vector ? "vector32(?)" : "?"
          ).join(",")
        })`
      ).join(",");
      const values = batch.flatMap((row) =>
        fields.map((field) => {
          const value = row[field] ?? null;
          return json.has(field) && (field !== "vector" || value !== null)
            ? JSON.stringify(value)
            : value;
        })
      );
      await db.prepare(
        `INSERT ${ignore ? "OR IGNORE" : ""} INTO ${table}(${
          fields.join(",")
        }) VALUES ${marks} ${conflict}`,
      ).run(...values);
    }
  }

  static async open(directory) {
    const module = await imports.turso();
    const storage = new TursoStorage();
    storage.db = await module.connect(path.join(directory, "turso.db"), {
      experimental: ["index_method"],
    });
    storage.tail = Promise.resolve();
    storage.capabilities = {
      driver: "turso",
      fulltext: true,
      vectors: "exact-cosine",
      publication: "per-document-transaction",
    };
    try {
      const legacy = await storage.db.prepare(
        "SELECT name FROM sqlite_master WHERE name='rag_catalog'",
      ).get();
      if (legacy) {
        throw new RagError(
          "LEGACY_STORAGE",
          "Use a fresh storageDir; snapshot stores are not converted",
        );
      }
      for (
        const statement of [
          `CREATE TABLE IF NOT EXISTS docs (
          id TEXT PRIMARY KEY, path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE,
          mime TEXT, size_bytes INTEGER, mtime TEXT, sample_hash TEXT, sample_scheme TEXT,
          content_hash TEXT, data_id TEXT, pipeline_key TEXT, stale INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, checked_at TEXT, indexed_at TEXT
        )`,
          "CREATE INDEX IF NOT EXISTS docs_stale ON docs(stale,id)",
          "CREATE INDEX IF NOT EXISTS docs_mime ON docs(mime)",
          `CREATE TABLE IF NOT EXISTS docs_data (
          id TEXT PRIMARY KEY, base_key TEXT NOT NULL, content_hash TEXT NOT NULL,
          extraction_key TEXT NOT NULL, context_key TEXT NOT NULL, mime TEXT NOT NULL,
          body TEXT NOT NULL, body_format TEXT NOT NULL, structure TEXT NOT NULL,
          metadata TEXT NOT NULL, languages TEXT NOT NULL, warnings TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
          "CREATE INDEX IF NOT EXISTS docs_data_lookup ON docs_data(base_key,created_at)",
          `CREATE TABLE IF NOT EXISTS user_meta (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, value TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )`,
          "CREATE INDEX IF NOT EXISTS user_meta_fts ON user_meta USING fts (value)",
          `CREATE TABLE IF NOT EXISTS docs_user_meta (
          doc_id TEXT NOT NULL, user_meta_id TEXT NOT NULL, PRIMARY KEY(doc_id,user_meta_id)
        )`,
          "CREATE INDEX IF NOT EXISTS docs_user_meta_reverse ON docs_user_meta(user_meta_id,doc_id)",
          `CREATE TABLE IF NOT EXISTS docs_chunks (
          id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, payload_kind TEXT NOT NULL,
          text TEXT, asset_ref TEXT, input_hash TEXT NOT NULL, embedding_key TEXT NOT NULL,
          embedding_config TEXT NOT NULL, dimensions INTEGER, vector BLOB
        )`,
          "CREATE INDEX IF NOT EXISTS docs_chunks_fts ON docs_chunks USING fts (text)",
          "CREATE INDEX IF NOT EXISTS docs_chunks_embedding ON docs_chunks(embedding_key,id)",
          `CREATE TABLE IF NOT EXISTS docs_chunks_links (
          id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
          data_id TEXT, user_meta_id TEXT, user_meta_input_hash TEXT,
          chunking_key TEXT NOT NULL, ordinal INTEGER NOT NULL, unit_index INTEGER,
          start_offset INTEGER, end_offset INTEGER, kind TEXT NOT NULL, origin TEXT NOT NULL,
          language TEXT, language_source TEXT, programming_language TEXT, unit_mime TEXT,
          page_start INTEGER, page_end INTEGER, time_start_ms REAL, time_end_ms REAL,
          locator TEXT NOT NULL, metadata TEXT NOT NULL
        )`,
          "CREATE INDEX IF NOT EXISTS docs_chunks_links_doc ON docs_chunks_links(doc_id,ordinal)",
          "CREATE INDEX IF NOT EXISTS docs_chunks_links_chunk ON docs_chunks_links(chunk_id,doc_id)",
          "CREATE INDEX IF NOT EXISTS docs_chunks_links_meta ON docs_chunks_links(user_meta_id)",
          "CREATE TEMP TABLE query_docs(id TEXT PRIMARY KEY)",
        ]
      ) await storage.db.exec(statement);
      return storage;
    } catch (error) {
      await storage.db.close();
      throw error;
    }
  }

  locked(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  doc(id) {
    return this.statement("get", "SELECT * FROM docs WHERE id=?", id);
  }

  byPath(key) {
    return this.statement("get", "SELECT * FROM docs WHERE path_key=?", key);
  }

  documents({ after = "", limit = 256, stale = false } = {}) {
    return this.statement(
      "all",
      `SELECT * FROM docs WHERE id>? ${
        stale ? "AND stale=1" : ""
      } ORDER BY id LIMIT ?`,
      after,
      limit,
    );
  }

  pending(document) {
    return this.locked(async () => {
      const now = new Date().toISOString();
      await this.db.prepare(
        `INSERT INTO docs(id,path,path_key,mime,size_bytes,mtime,sample_hash,sample_scheme,stale,created_at,updated_at,checked_at)
        VALUES(?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(path_key) DO UPDATE SET
        mime=COALESCE(excluded.mime,docs.mime),size_bytes=excluded.size_bytes,mtime=excluded.mtime,
        sample_hash=excluded.sample_hash,sample_scheme=excluded.sample_scheme,
        content_hash=NULL,stale=1,updated_at=excluded.updated_at,checked_at=excluded.checked_at`,
      ).run(
        document.id,
        document.path,
        document.path_key,
        document.mime ?? null,
        document.size_bytes ?? null,
        document.mtime ?? null,
        document.sample_hash ?? null,
        document.sample_scheme ?? null,
        now,
        now,
        now,
      );
      return await this.db.prepare("SELECT * FROM docs WHERE path_key=?").get(
        document.path_key,
      );
    });
  }

  markStale(ids) {
    if (!ids.length) return Promise.resolve();
    return this.transaction(async (tx) => {
      for (const id of ids) {
        await tx.prepare("UPDATE docs SET stale=1,updated_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
      }
    });
  }

  invalidatePipeline(key) {
    return this.statement(
      "run",
      "UPDATE docs SET stale=1 WHERE pipeline_key IS NULL OR pipeline_key<>?",
      key,
    );
  }

  checked(id) {
    return this.statement(
      "run",
      "UPDATE docs SET checked_at=? WHERE id=?",
      new Date().toISOString(),
      id,
    );
  }

  data(baseKey) {
    return this.locked(async () => {
      const row = await this.db.prepare(
        "SELECT * FROM docs_data WHERE base_key=? ORDER BY created_at DESC,id DESC LIMIT 1",
      ).get(baseKey);
      if (!row) return null;
      return {
        ...row,
        units: JSON.parse(row.structure).map((
          { bodyStart, bodyEnd, ...unit },
        ) => ({
          ...unit,
          text: row.body.slice(bodyStart, bodyEnd),
        })),
        metadata: JSON.parse(row.metadata),
        languages: JSON.parse(row.languages),
        warnings: JSON.parse(row.warnings),
      };
    });
  }

  putData(data) {
    return this.locked(async () => {
      let body = "";
      const structure = data.units.map(({ text, ...unit }) => {
        const bodyStart = body.length;
        body += text;
        const bodyEnd = body.length;
        body += "\n\n";
        return { ...unit, bodyStart, bodyEnd };
      });
      await this.insert(
        this.db,
        "docs_data",
        "id base_key content_hash extraction_key context_key mime body body_format structure metadata languages warnings created_at",
        [{
          ...data,
          body,
          structure,
          body_format: data.body_format ?? "text",
          metadata: data.metadata ?? {},
          languages: data.languages ?? null,
          warnings: data.warnings ?? [],
          created_at: new Date().toISOString(),
        }],
        { ignore: true },
      );
    });
  }

  chunks(ids) {
    return this.locked(async () => {
      const rows = [];
      for (const batch of groups(ids, 200)) {
        rows.push(
          ...await this.db.prepare(
            `SELECT id,dimensions,vector IS NOT NULL AS embedded FROM docs_chunks WHERE id IN (${
              batch.map(() => "?").join(",")
            })`,
          ).all(...batch),
        );
      }
      return rows;
    });
  }

  dimensions(key) {
    return this.locked(async () =>
      (await this.db.prepare(
        "SELECT dimensions FROM docs_chunks WHERE embedding_key=? AND vector IS NOT NULL LIMIT 1",
      ).get(key))?.dimensions
    );
  }

  publish(document, chunks, links, isCurrent) {
    return this.transaction(async (tx) => {
      if (
        !await tx.prepare("SELECT id FROM docs WHERE id=?").get(document.id)
      ) return;
      await this.insert(
        tx,
        "docs_chunks",
        "id payload_hash payload_kind text asset_ref input_hash embedding_key embedding_config dimensions vector",
        chunks.map((chunk) => ({ ...chunk, dimensions: chunk.vector?.length })),
        {
          conflict:
            "ON CONFLICT(id) DO UPDATE SET vector=COALESCE(excluded.vector,docs_chunks.vector),dimensions=COALESCE(excluded.dimensions,docs_chunks.dimensions)",
        },
      );
      await tx.prepare("DELETE FROM docs_chunks_links WHERE doc_id=?").run(
        document.id,
      );
      await this.insert(
        tx,
        "docs_chunks_links",
        "id doc_id chunk_id data_id user_meta_id user_meta_input_hash chunking_key ordinal unit_index start_offset end_offset kind origin language language_source programming_language unit_mime page_start page_end time_start_ms time_end_ms locator metadata",
        links.map((link) => ({
          ...link,
          doc_id: document.id,
          start_offset: link.start,
          end_offset: link.end,
        })),
      );
      const now = new Date().toISOString();
      const fields =
        "mime size_bytes mtime sample_hash sample_scheme content_hash data_id pipeline_key"
          .split(" ");
      await tx.prepare(
        "UPDATE docs SET " + fields.map((field) => field + "=?").join(",") +
          ",stale=?,updated_at=?,checked_at=?,indexed_at=? WHERE id=?",
      ).run(
        ...fields.map((field) => document[field]),
        isCurrent() ? 0 : 1,
        now,
        now,
        now,
        document.id,
      );
    });
  }

  removeDoc(id) {
    return this.transaction(async (tx) => {
      await tx.prepare("DELETE FROM docs_chunks_links WHERE doc_id=?").run(
        id,
      );
      await tx.prepare("DELETE FROM docs_user_meta WHERE doc_id=?").run(id);
      await tx.prepare("DELETE FROM docs WHERE id=?").run(id);
    });
  }

  async metadata({ documentId, type, query } = {}) {
    const conditions = [];
    const args = [];
    if (query) {
      conditions.push("fts_match(value,?1)");
      args.push(fullTextQuery(query));
    }
    if (documentId) {
      conditions.push(
        "id IN (SELECT user_meta_id FROM docs_user_meta WHERE doc_id=?)",
      );
      args.push(documentId);
    }
    if (type) {
      conditions.push("type=?");
      args.push(type);
    }
    const select = `SELECT ${
      query ? "*,fts_score(value,?1) AS score" : "*"
    } FROM user_meta
      ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}`;
    const rows = await this.statement(
      "all",
      select + (query ? "" : " ORDER BY id"),
      ...args,
    );
    return query ? rows.sort(byScore) : rows;
  }

  mutateMeta({ action, id, type, value, documentIds = [] }) {
    return this.transaction(async (tx) => {
      const old = await tx.prepare("SELECT * FROM user_meta WHERE id=?").get(
        id,
      );
      if (action !== "add" && !old) {
        throw new RagError("META_NOT_FOUND", "Unknown user metadata ID");
      }
      for (const docId of documentIds) {
        if (!await tx.prepare("SELECT id FROM docs WHERE id=?").get(docId)) {
          throw new RagError("DOCUMENT_NOT_FOUND", "Unknown document ID");
        }
      }
      const affected = new Set((await tx.prepare(
        "SELECT doc_id FROM docs_user_meta WHERE user_meta_id=?",
      ).all(id)).map((row) => row.doc_id));
      const now = new Date().toISOString();
      if (action === "add") {
        await tx.prepare("INSERT INTO user_meta VALUES(?,?,?,?,?)").run(
          id,
          type,
          value,
          now,
          now,
        );
      } else if (action === "update") {
        await tx.prepare(
          "UPDATE user_meta SET type=?,value=?,updated_at=? WHERE id=?",
        )
          .run(type ?? old.type, value ?? old.value, now, id);
      } else if (action === "remove") {
        await tx.prepare("DELETE FROM docs_user_meta WHERE user_meta_id=?")
          .run(id);
        await tx.prepare("DELETE FROM user_meta WHERE id=?").run(id);
      }
      for (const docId of documentIds) {
        affected.add(docId);
        if (action === "unlink") {
          await tx.prepare(
            "DELETE FROM docs_user_meta WHERE doc_id=? AND user_meta_id=?",
          ).run(docId, id);
        } else {
          await tx.prepare("INSERT OR IGNORE INTO docs_user_meta VALUES(?,?)")
            .run(docId, id);
        }
      }
      for (const docId of affected) {
        await tx.prepare("UPDATE docs SET stale=1,updated_at=? WHERE id=?")
          .run(now, docId);
      }
      return { id, affected: [...affected] };
    });
  }

  retrieve({ query, documentIds, mode, vector, embeddingKey, limit, filters }) {
    return this.locked(async () => {
      await this.db.exec("DELETE FROM query_docs");
      await this.insert(
        this.db,
        "query_docs",
        "id",
        documentIds.map((id) => ({ id })),
        { ignore: true },
      );
      const conditions = [];
      const args = [];
      for (
        const [field, values] of [["kind", filters.kinds], [
          "origin",
          filters.origins,
        ], ["language", filters.languages]]
      ) {
        if (values) {
          conditions.push(
            values.length
              ? `l.${field} IN (${values.map(() => "?").join(",")})`
              : "0",
          );
          args.push(...values);
        }
      }
      const where = conditions.length ? " AND " + conditions.join(" AND ") : "";
      const eligible =
        `SELECT l.chunk_id FROM docs_chunks_links l JOIN query_docs q ON q.id=l.doc_id WHERE 1=1${where}`;
      const branches = [];
      if (mode !== "vector") {
        // IN preserves scores, but Turso 0.8.3 can ignore FTS ORDER BY here.
        // The shared rank policy sorts scoped matches before limiting/fusion.
        branches.push(
          await this.db.prepare(
            `SELECT id,fts_score(text,?1) AS score FROM docs_chunks
          WHERE fts_match(text,?1) AND id IN (${eligible})`,
          ).all(fullTextQuery(query), ...args),
        );
      }
      if (mode !== "fulltext") {
        const input = await this.db.prepare("SELECT vector32(?) AS value").get(
          JSON.stringify(vector),
        );
        branches.push(
          await this.db.prepare(
            `SELECT id,1-vector_distance_cos(vector,?) AS score FROM docs_chunks
          WHERE embedding_key=? AND vector IS NOT NULL AND id IN (${eligible})
          ORDER BY score DESC,id LIMIT ?`,
          ).all(input.value, embeddingKey, ...args, limit * 4),
        );
      }
      const selected = rankResults(branches, mode, limit);
      const records = new Map(selected.map((hit) => [hit.id, hit]));
      for (const batch of groups(selected.map((hit) => hit.id), 200)) {
        const marks = batch.map(() => "?").join(",");
        for (
          const row of await this.db.prepare(
            `SELECT id,text,payload_kind,asset_ref FROM docs_chunks WHERE id IN (${marks})`,
          ).all(...batch)
        ) {
          Object.assign(records.get(row.id), row, { citations: [] });
        }
        for (
          const row of await this.db.prepare(
            `SELECT l.*,d.path,d.mime,d.stale FROM docs_chunks_links l
          JOIN docs d ON d.id=l.doc_id JOIN query_docs q ON q.id=d.id
          WHERE l.chunk_id IN (${marks})${where} ORDER BY d.path,l.ordinal`,
          ).all(...batch, ...args)
        ) {
          records.get(row.chunk_id).citations.push({
            ...row,
            locator: JSON.parse(row.locator),
            metadata: JSON.parse(row.metadata),
          });
        }
      }
      return [...records.values()];
    });
  }

  async counts() {
    const counts = await this.statement(
      "get",
      `SELECT
      (SELECT COUNT(*) FROM docs) AS documents,
      (SELECT COUNT(*) FROM docs_data) AS extractions,
      (SELECT COUNT(*) FROM docs_chunks) AS chunks,
      (SELECT COUNT(*) FROM docs_chunks_links) AS occurrences,
      (SELECT COUNT(*) FROM user_meta) AS userMeta,
      (SELECT COUNT(DISTINCT content_hash) FROM docs_data) AS contents,
      (SELECT COUNT(*) FROM docs_chunks WHERE vector IS NOT NULL) AS embeddings,
      (SELECT COUNT(*) FROM docs WHERE stale=1) AS stale`,
    );
    return Object.fromEntries(
      Object.entries(counts).map(([key, value]) => [key, Number(value)]),
    );
  }

  gc() {
    return this.transaction(async (tx) => {
      const removed = await tx.prepare(
        "DELETE FROM docs_chunks WHERE NOT EXISTS (SELECT 1 FROM docs_chunks_links l WHERE l.chunk_id=docs_chunks.id)",
      ).run();
      await tx.exec(
        "DELETE FROM docs_data WHERE NOT EXISTS (SELECT 1 FROM docs WHERE docs.data_id=docs_data.id)",
      );
      return { chunksRemoved: Number(removed.changes) };
    });
  }

  rebuild() {
    return this.transaction(async (tx) => {
      for (
        const [table, column] of [["docs_chunks", "text"], [
          "user_meta",
          "value",
        ]]
      ) {
        await tx.exec(`DROP INDEX ${table}_fts`);
        await tx.exec(
          `CREATE INDEX ${table}_fts ON ${table} USING fts (${column})`,
        );
      }
      return { indexesRebuilt: true };
    });
  }

  async close() {
    await this.tail;
    await this.db.close();
  }
}

// Provider boundary: explicit input/options/context objects; callbacks never
// receive database objects. Native resources and caches belong to this instance.
class ContentProviders {
  hook(name, request, builtin) {
    const next = (replacement = request) => builtin.call(this, replacement);
    return typeof this.options[name] === "function"
      ? this.options[name](request, next)
      : next();
  }

  constructor({ rootDir, storageDir, options, limits }) {
    this.rootDir = rootDir;
    this.storageDir = storageDir;
    this.options = { ...options };
    this.limits = limits;
    this.models = path.join(storageDir, "models");
    this.hookName = `rag-${crypto.randomUUID()}`;
    this.hookRegistered = false;
    this.ocrOptions = {
      mode: "paddle",
      languages: "auto",
      ...(typeof options.ocr === "object" ? options.ocr : {}),
    };
    this.transcribeOptions = {
      enabled: true,
      provider: "node-av",
      model: "tiny",
      language: "auto",
      threads: 4,
      ...(typeof options.transcribe === "object" ? options.transcribe : {}),
    };
    this.embeddingOptions = {
      model: "multilingual",
      ...(typeof options.embedding === "object" ? options.embedding : {}),
    };
    this.embeddingConfig = options.embedding === false ? {} : {
      provider: typeof options.embedding === "function"
        ? "callback"
        : "xberg-1.3.10",
      model: typeof this.embeddingOptions.model === "string"
        ? this.embeddingOptions.model
        : "custom",
      modelFingerprint: hash(this.embeddingOptions.model),
      metric: "cosine",
    };
    this.hookVersions = {};
    for (const name of ["ocr", "transcribe", "extract", "embedding"]) {
      if (typeof options[name] === "function") {
        this.hookVersions[name] = options.hookVersion?.[name] ??
          crypto.randomUUID();
      }
    }
    this.extractionContext = options.cache?.extractionContext ??
      (["ocr", "transcribe", "extract"].some((name) =>
          typeof options[name] === "function"
        )
        ? "path"
        : "filename");
    if (!["content", "filename", "path"].includes(this.extractionContext)) {
      throw new TypeError(
        "cache.extractionContext must be content, filename or path",
      );
    }
    this.extractionSignature = hash({
      extraction: 1,
      documentTraversal: 2,
      imageMetadata: 1,
      xberg: "1.3.10",
      ocr: options.ocr === false ? false : this.ocrOptions,
      transcribe: options.transcribe === false ? false : this.transcribeOptions,
      hooks: { ...this.hookVersions, embedding: undefined },
      nativeProfile: ["native", "auto"].includes(this.ocrOptions.mode)
        ? this.ocrOptions.profileVersion ?? crypto.randomUUID()
        : undefined,
      limits,
    });
    this.spaceId = options.embedding === false ? null : hash({
      version: 1,
      provider: "xberg-1.3.10",
      config: this.embeddingOptions,
      hook: this.hookVersions.embedding,
    });
  }

  xberg() {
    return this.xbergPromise ??= imports.xberg();
  }
  av() {
    return this.avPromise ??= imports.av();
  }

  input(value) {
    if (typeof value === "string" || value instanceof URL) {
      const filename = localPath(value, this.rootDir);
      return { path: filename, filename: path.basename(filename) };
    }
    if (!(value?.bytes instanceof Uint8Array)) {
      throw new TypeError(
        "Expected path, file: URL or {bytes: Uint8Array, mime?, filename?}",
      );
    }
    return {
      bytes: value.bytes,
      mime: value.mime,
      filename: value.filename ?? "input",
    };
  }

  async withFile(input, operation) {
    if (input.path) return await operation(input.path);
    const directory = await fs.mkdtemp(
      path.join(this.storageDir, "tmp", "input-"),
    );
    try {
      const filename = path.join(
        directory,
        "input" + path.extname(input.filename),
      );
      await fs.writeFile(filename, input.bytes);
      return await operation(filename);
    } finally {
      await fs.rm(directory, { recursive: true });
    }
  }

  async ocrConfig(settings, signal) {
    if (settings.mode === "paddle") {
      if (settings.languages === "auto") {
        const version = settings.paddle?.modelVersion ?? "pp-ocrv6";
        const tier = settings.paddle?.modelTier ?? "small";
        if (
          version !== "pp-ocrv6" ||
          !["small", "medium", "mobile", "server"].includes(tier)
        ) {
          throw new TypeError(
            "Paddle languages=auto requires PP-OCRv6 small or medium; use explicit languages with other models",
          );
        }
      }
      const languages = settings.languages === "auto"
        ? ["ch"]
        : typeof settings.languages === "string"
        ? [settings.languages]
        : settings.languages;
      if (!Array.isArray(languages) || !languages.length) {
        throw new TypeError("PaddleOCR requires a nonempty language list");
      }
      return {
        backend: "paddle-ocr",
        language: languages,
        paddleOcrSettings: {
          modelVersion: "pp-ocrv6",
          modelTier: "small",
          ...settings.paddle,
          cacheDir: path.join(this.models, "paddle"),
        },
      };
    }
    const languages = settings.languages === "auto"
      ? ["Latin", "Cyrillic", "Arabic", "chi_sim"]
      : typeof settings.languages === "string"
      ? [settings.languages]
      : settings.languages;
    if (!Array.isArray(languages) || !languages.length) {
      throw new TypeError(
        "ocr.languages must be auto, a model name or an array of model names",
      );
    }
    const directory = path.join(this.models, "tessdata");
    for (const language of languages) {
      if (!/^[A-Za-z_]+$/.test(language)) {
        throw new TypeError(`Invalid Tesseract model name: ${language}`);
      }
      await download(
        `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/${
          /^[A-Z]/.test(language) ? "script/" : ""
        }${language}.traineddata`,
        path.join(directory, `${language}.traineddata`),
        { signal },
      );
    }
    return {
      backend: "tesseract",
      language: languages,
      tessdataPath: directory,
    };
  }

  async ocr(request) {
    checkSignal(request.signal);
    if (this.options.ocr === false || this.ocrOptions.mode === "off") {
      return null;
    }
    const result = await this.hook("ocr", request, this.ocrBuiltin);
    if (result !== null && typeof result?.text !== "string") {
      throw new TypeError("OCR callback must return {text} or null");
    }
    return result;
  }

  async ocrBuiltin(request) {
    const settings = { ...this.ocrOptions, ...request.options };
    if (["native", "auto"].includes(settings.mode)) {
      const auto = await imports.auto();
      const image = await auto.vips.decodeImage(request.input.bytes);
      const result = await auto.ocr({ provider: "native", image });
      if (result) {
        return {
          text: result.text,
          provider: "native-os",
          warnings: [
            "Native OCR language coverage depends on OS and installed recognition packs.",
          ],
        };
      }
      if (settings.mode === "native") {
        throw new RagError("OCR_UNAVAILABLE", "Native OCR returned no result");
      }
    }
    if (!["native", "auto", "tesseract", "paddle"].includes(settings.mode)) {
      throw new TypeError(`Unknown OCR mode: ${settings.mode}`);
    }
    const ocr = await this.ocrConfig(settings, request.signal);
    const result = await this.xbergExtract(request.input, {
      forceOcr: true,
      acceleration: settings.mode === "paddle"
        ? settings.acceleration
        : undefined,
      ocr,
      securityLimits: this.securityLimits(),
    });
    return {
      text: result.results.map((item) => item.content ?? "").join("\n"),
      provider: settings.mode === "paddle" ? "xberg-paddle" : "xberg-tesseract",
      languages: ocr.language,
      metadata: result.results[0]?.metadata ?? {},
      warnings: result.results.flatMap((item) =>
        (item.processingWarnings ?? []).map((warning) => warning.message)
      ),
    };
  }

  async registerOcr() {
    if (this.hookRegistered) return;
    const xberg = await this.xberg();
    xberg.registerOcrBackend({
      name: () => this.hookName,
      version: () => VERSION,
      initialize() {},
      shutdown() {},
      backendType: () => xberg.OcrBackendType.Custom,
      supportsLanguage: () => true,
      processImage: async (input) => {
        const bytes = new Uint8Array(Array.isArray(input) ? input[0] : input);
        const result = await this.ocr({
          input: { bytes, mime: "image/png", filename: "page.png" },
          options: this.ocrOptions,
          document: this.ocrContext?.document,
          signal: this.ocrContext?.signal,
        });
        return {
          content: result?.text ?? "",
          mimeType: "text/plain",
          metadata: {},
          tables: [],
          processingWarnings: (result?.warnings ?? []).map((message) => ({
            source: this.hookName,
            message,
          })),
        };
      },
    });
    this.hookRegistered = true;
  }

  securityLimits() {
    return {
      maxPages: this.limits.maxPages,
      maxArchiveSize: this.limits.maxArchiveBytes,
      maxFilesInArchive: this.limits.maxArchiveEntries,
    };
  }

  async xbergExtract(input, options) {
    const xberg = await this.xberg();
    const source = input.bytes
      ? {
        kind: "bytes",
        bytes: input.bytes,
        mimeType: input.mime,
        filename: input.filename,
      }
      : {
        kind: "uri",
        uri: input.path,
        filename: input.filename,
      };
    const result = await xberg.extract(source, { useCache: false, ...options });
    if (result.errors?.length) {
      throw new RagError("EXTRACTION_PARTIAL", JSON.stringify(result.errors));
    }
    if (!Array.isArray(result.results)) {
      throw new RagError(
        "EXTRACTION_RESULT",
        "Xberg returned no document envelope",
      );
    }
    return result;
  }

  async extract(request) {
    const result = await this.hook("extract", request, this.extractBuiltin);
    if (result === null) {
      throw new SkipFile(
        "EXTRACTION_SKIPPED",
        "Extraction hook skipped this file",
      );
    }
    if (!Array.isArray(result.units)) {
      throw new TypeError(
        "Extraction callback must return {mime, units: [{text, locator?}]} or null",
      );
    }
    return {
      ...result,
      units: result.units.map((unit) => {
        if (typeof unit.text !== "string") {
          throw new TypeError("Extraction units require string text");
        }
        return { ...unit, text: unit.text.replace(/\r\n?/g, "\n") };
      }),
    };
  }

  async classify(filename) {
    const file = await fs.open(filename, "r");
    const bytes = new Uint8Array(8192);
    let size;
    try {
      size = (await file.read(bytes, 0, bytes.length, 0)).bytesRead;
    } finally {
      await file.close();
    }
    const prefix = bytes.subarray(0, size ?? 0);
    const ascii = new TextDecoder("latin1").decode(prefix.subarray(0, 16));
    if (ascii.startsWith("%PDF-")) {
      return { mime: "application/pdf", evidence: "signature" };
    }
    if (prefix[0] === 137 && ascii.slice(1, 4) === "PNG") {
      return { mime: "image/png", evidence: "signature" };
    }
    if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) {
      return { mime: "image/jpeg", evidence: "signature" };
    }
    const media = ascii.startsWith("ID3") || ascii.startsWith("fLaC") ||
      ascii.startsWith("OggS") ||
      (ascii.startsWith("RIFF") && /WAVE|AVI /.test(ascii)) ||
      ascii.slice(4, 8) === "ftyp" ||
      (prefix[0] === 0 && prefix[1] === 0 && prefix[2] === 1 &&
        [0xb3, 0xba].includes(prefix[3])) ||
      (prefix[0] === 255 && (prefix[1] & 0xe0) === 0xe0) ||
      (prefix[0] === 0x1a && prefix[1] === 0x45 && prefix[2] === 0xdf &&
        prefix[3] === 0xa3);
    if (media) {
      const probe = await this.probe({ path: filename });
      if (
        probe.format.includes("webm") &&
        new TextDecoder().decode(prefix).includes("webm")
      ) {
        probe.mime = `${probe.mediaType}/webm`;
      }
      return { ...probe, evidence: "native-demuxer" };
    }
    return { mime: null, evidence: "pending-xberg" };
  }

  async probe(input) {
    const av = await this.av();
    return await this.withFile(input, async (filename) => {
      await using demuxer = await av.Demuxer.open(filename);
      const candidate = demuxer.video(0);
      const video =
        candidate && !(candidate.disposition & av.AV_DISPOSITION_ATTACHED_PIC)
          ? candidate
          : null;
      const audio = demuxer.audio(0);
      if (!video && !audio) {
        throw new RagError("MEDIA_STREAM", "No audio/video stream found");
      }
      const format = demuxer.formatName ?? "";
      const container = format.split(",")[0];
      const known = {
        mp3: "audio/mpeg",
        wav: "audio/wav",
        flac: "audio/flac",
        aac: "audio/aac",
        avi: "video/x-msvideo",
        mpegts: "video/mp2t",
        mpeg: "video/mpeg",
        mpegvideo: "video/mpeg",
      };
      const mime = known[container] ??
        (container === "mov"
          ? `${video ? "video" : "audio"}/mp4`
          : container === "ogg"
          ? `${video ? "video" : "audio"}/ogg`
          : container === "matroska"
          ? (video ? "video/x-matroska" : "audio/x-matroska")
          : "application/octet-stream");
      let durationSeconds = demuxer.duration;
      let durationEvidence = "container";
      if (video && !(durationSeconds > 0)) {
        // Elementary MPEG can lack a container duration but have usable DTS.
        // Inspect compressed packets without decoding frames or guessing FPS.
        let start = Infinity;
        let end = -Infinity;
        const limits = this.limits.video;
        this.enforceMedia(limits, (await fs.stat(filename)).size, 0);
        for await (using packet of demuxer.packets(video.index)) {
          if (!packet) continue;
          const timestamp = packet.pts !== av.AV_NOPTS_VALUE
            ? packet.pts
            : packet.dts;
          if (timestamp === av.AV_NOPTS_VALUE) continue;
          const scale = packet.timeBase.num / packet.timeBase.den;
          const time = Number(timestamp) * scale;
          if (!Number.isFinite(time)) continue;
          start = Math.min(start, time);
          end = Math.max(
            end,
            time + Math.max(0, Number(packet.duration)) * scale,
          );
          if (end - start > limits.maxDurationSeconds) break;
        }
        if (Number.isFinite(end - start) && end > start) {
          durationSeconds = end - start;
          durationEvidence = "packet-timestamps";
        }
      }
      return {
        mime,
        mediaType: video ? "video" : "audio",
        durationSeconds,
        durationEvidence,
        hasAudio: Boolean(audio),
        hasVideo: Boolean(video),
        format,
      };
    });
  }

  async extractBuiltin(request) {
    checkSignal(request.signal);
    const input = request.input;
    const classification = request.classification ??
      await this.classify(input.path);
    if (classification.mediaType) {
      return await this.extractMedia(request, classification);
    }
    if (classification.mime?.startsWith("image/")) {
      const result = await this.ocr({
        input: {
          ...input,
          bytes: await fs.readFile(input.path),
          mime: classification.mime,
        },
        options: this.ocrOptions,
        signal: request.signal,
        document: request.document,
      });
      if (!result) {
        throw new SkipFile("OCR_DISABLED", "Image OCR was disabled or skipped");
      }
      return {
        mime: classification.mime,
        units: [{
          text: result.text,
          locator: {
            mime: classification.mime,
            metadata: result.metadata ?? {},
          },
        }],
        provider: result.provider,
        languages: result.languages,
        warnings: result.warnings ?? [],
      };
    }
    const config = {
      disableOcr: this.options.ocr === false || this.ocrOptions.mode === "off",
      pages: { extractPages: true },
      maxArchiveDepth: this.limits.maxArchiveDepth,
      maxEmbeddedFileBytes: this.limits.maxFileBytes,
      securityLimits: this.securityLimits(),
      mimeDetectionPolicy: "prefer_content",
    };
    if (!config.disableOcr) {
      const custom = typeof this.options.ocr === "function" ||
        ["native", "auto", "paddle"].includes(this.ocrOptions.mode);
      if (custom) {
        await this.registerOcr();
        config.ocr = { backend: this.hookName, language: ["eng"] };
      } else {
        config.ocr = await this.ocrConfig(this.ocrOptions, request.signal);
      }
    }
    this.ocrContext = request;
    let result;
    try {
      result = await this.xbergExtract(input, config);
    } finally {
      this.ocrContext = null;
    }
    const units = [];
    const warnings = [];
    const visit = (document, resultIndex, entries = []) => {
      warnings.push(
        ...(document.processingWarnings ?? []).map((warning) =>
          warning.message
        ),
      );
      if (document.children) {
        for (const entry of document.children) {
          visit(entry.result, resultIndex, [...entries, entry.path]);
        }
        return;
      }
      const base = {
        resultIndex,
        metadata: document.metadata ?? {},
        mime: document.mimeType,
        ...(entries.length ? { entries } : {}),
      };
      if (document.pages?.length) {
        for (const page of document.pages) {
          units.push({
            text: page.content,
            locator: { ...base, page: page.pageNumber },
          });
        }
      } else units.push({ text: document.content ?? "", locator: base });
    };
    for (const [resultIndex, document] of result.results.entries()) {
      visit(document, resultIndex);
    }
    return {
      mime: result.results[0]?.mimeType ?? classification.mime ??
        "application/octet-stream",
      units,
      provider: "xberg",
      warnings,
    };
  }

  async transcribe(request) {
    checkSignal(request.signal);
    if (this.options.transcribe === false || !this.transcribeOptions.enabled) {
      throw new SkipFile("TRANSCRIPTION_DISABLED", "Transcription is disabled");
    }
    const result = await this.hook(
      "transcribe",
      request,
      this.transcribeBuiltin,
    );
    if (result === null) return null;
    if (typeof result?.text !== "string") {
      throw new TypeError(
        "Transcription callback must return {text, segments?} or null",
      );
    }
    return { segments: [], warnings: [], ...result };
  }

  async whisperModel(settings, signal) {
    const directory = path.join(this.models, "whisper");
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, `ggml-${settings.model}.bin`);
    if (settings.modelPath) {
      const original = localPath(settings.modelPath, this.rootDir);
      if (original !== filename) await fs.copyFile(original, filename);
      return directory;
    }
    if (settings.model !== "tiny") {
      throw new TypeError(
        "Supply transcribe.modelPath for models other than tiny in this release",
      );
    }
    await download(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin",
      filename,
      {
        signal,
        sha256:
          "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
      },
    );
    return directory;
  }

  async transcribeBuiltin(request) {
    const settings = { ...this.transcribeOptions, ...request.options };
    if (!["node-av", "auto"].includes(settings.provider)) {
      throw new TypeError(
        "This release supports node-av transcription or a callback",
      );
    }
    if (settings.model.endsWith(".en") && settings.language === "auto") {
      throw new TypeError(
        "Automatic language detection requires a multilingual Whisper model",
      );
    }
    const av = await this.av();
    return await this.withFile(request.input, async (filename) => {
      await using input = await av.Demuxer.open(filename);
      const video = Boolean(input.video(0));
      const limits = video ? this.limits.video : this.limits.audio;
      const stat = await fs.stat(filename);
      this.enforceMedia(limits, stat.size, input.duration);
      const audio = input.audio(0);
      if (!audio) {
        return {
          text: "",
          segments: [],
          provider: "node-av",
          model: settings.model,
          language: { requested: settings.language },
          warnings: ["No audio stream"],
        };
      }
      const modelDir = await this.whisperModel(settings, request.signal);
      using decoder = await av.Decoder.create(audio, {
        signal: request.signal,
      });
      checkedNumber(settings.threads, "transcribe.threads", {
        min: 1,
        integer: true,
      });
      const chain = av.FilterPreset.chain().whisper({
        model: path.join(modelDir, `ggml-${settings.model}.bin`),
        language: settings.language,
        useGpu: settings.useGpu ?? false,
        gpuDevice: settings.gpuDevice ?? 0,
        queue: 30,
      }).build();
      using transcriber = av.FilterAPI.create(chain, {
        graph: { nbThreads: settings.threads },
        signal: request.signal,
      });
      const boundedFrames = async function* () {
        let seconds = 0;
        for await (
          const frame of decoder.frames(input.packets(audio.index))
        ) {
          if (frame) seconds += frame.nbSamples / frame.sampleRate;
          if (seconds > limits.maxDurationSeconds) {
            frame?.free();
            throw new SkipFile(
              "MAX_DURATION",
              "Decoded audio exceeded duration limit",
            );
          }
          checkSignal(request.signal);
          yield frame;
        }
      };
      const segments = [];
      let position = 0;
      for await (using frame of transcriber.frames(boundedFrames())) {
        if (!frame) continue;
        checkSignal(request.signal);
        const metadata = frame.getMetadata();
        const text = metadata.get("lavfi.whisper.text")?.trim();
        if (!text) continue;
        const duration = Number(
          metadata.get("lavfi.whisper.duration") ?? 0,
        );
        if (position + duration > limits.maxDurationSeconds) {
          throw new SkipFile(
            "MAX_DURATION",
            "Decoded audio exceeded duration limit",
          );
        }
        segments.push({ start: position, end: position + duration, text });
        position += duration;
      }
      return {
        text: segments.map((segment) => segment.text.trim()).join(" "),
        segments,
        provider: "node-av",
        model: settings.model,
        language: { requested: settings.language },
        warnings: [],
      };
    });
  }

  enforceMedia(limits, bytes, duration) {
    if (bytes > limits.maxFileBytes) {
      throw new SkipFile(
        "MAX_FILE_BYTES",
        `File exceeds ${limits.maxFileBytes} bytes`,
      );
    }
    if (duration > limits.maxDurationSeconds) {
      throw new SkipFile(
        "MAX_DURATION",
        `Media exceeds ${limits.maxDurationSeconds} seconds`,
      );
    }
  }

  async extractMedia(request, classification) {
    const limits = this.limits[classification.mediaType];
    this.enforceMedia(
      limits,
      (await fs.stat(request.input.path)).size,
      classification.durationSeconds,
    );
    const units = [];
    const warnings = [];
    if (
      classification.hasAudio && this.options.transcribe !== false &&
      this.transcribeOptions.enabled &&
      (classification.mediaType !== "video" || limits.transcribe)
    ) {
      const result = await this.transcribe({
        input: request.input,
        options: this.transcribeOptions,
        signal: request.signal,
        document: request.document,
      });
      if (result) {
        if (result.segments.length) {
          for (const segment of result.segments) {
            units.push({
              text: segment.text,
              locator: {
                channel: "audio",
                start: segment.start,
                end: segment.end,
              },
            });
          }
        } else units.push({ text: result.text, locator: { channel: "audio" } });
        warnings.push(...result.warnings);
      }
    }
    if (
      classification.mediaType === "video" && limits.ocr &&
      this.options.ocr !== false
    ) {
      units.push(
        ...await this.videoFrames(request, classification, limits.ocr),
      );
    }
    if (!units.length) {
      throw new SkipFile(
        "MEDIA_DISABLED",
        "No enabled extraction channel produced units",
      );
    }
    return {
      mime: classification.mime,
      units,
      provider: "node-av",
      warnings,
      sampling: classification.hasVideo ? limits.ocr : undefined,
    };
  }

  async videoFrames(request, classification, settings) {
    if (!(classification.durationSeconds > 0)) {
      throw new SkipFile(
        "UNKNOWN_DURATION",
        "Video OCR sampling requires a known duration",
      );
    }
    const av = await this.av();
    await using input = await av.Demuxer.open(request.input.path);
    const units = [];
    const interval = Math.max(
      settings.intervalSeconds,
      classification.durationSeconds / settings.maxFrames,
    );
    let nextTime = 0;
    let count = 0;
    const stream = input.video(0);
    using decoder = await av.Decoder.create(stream, { signal: request.signal });
    using filter = av.FilterAPI.create(
      `scale=w='min(iw,${settings.maxWidth})':h=-1,format=rgb24`,
      { signal: request.signal },
    );
    using png = await av.Encoder.create(av.FF_ENCODER_PNG, {
      autoFormat: true,
      context: { threadCount: 1 },
      signal: request.signal,
    });
    for await (using frame of decoder.frames(input.packets(stream.index))) {
      if (!frame) continue;
      checkSignal(request.signal);
      const time = Number(frame.pts) * frame.timeBase.num /
        frame.timeBase.den;
      if (time < nextTime) continue;
      if (count >= settings.maxFrames) break;
      for await (using scaled of filter.frames(frame)) {
        if (!scaled) continue;
        for await (const packet of png.packets(scaled)) {
          if (!packet) continue;
          const bytes = new Uint8Array(packet.data);
          const result = await this.ocr({
            input: { bytes, mime: "image/png", filename: "frame.png" },
            options: this.ocrOptions,
            signal: request.signal,
            document: request.document,
          });
          if (result) {
            units.push({
              text: result.text,
              locator: {
                channel: "video-ocr",
                start: time,
                end: Math.min(
                  time + interval,
                  classification.durationSeconds,
                ),
                frame: count,
                intervalSeconds: interval,
              },
            });
          }
        }
      }
      count++;
      nextTime = time + interval;
    }
    return units;
  }

  async embed(texts, { role = "document", signal } = {}) {
    if (this.options.embedding === false) {
      throw new RagError("EMBEDDING_DISABLED", "Embeddings are disabled");
    }
    if (!["query", "document"].includes(role)) {
      throw new TypeError("Embedding role must be query or document");
    }
    const request = { texts, role, signal, model: this.embeddingOptions.model };
    const output = await this.hook("embedding", request, this.embedBuiltin);
    const vectors = vectorsChecked(output.vectors ?? output, texts.length);
    return { spaceId: this.spaceId, vectors };
  }

  async embedBuiltin({ texts, role, signal }) {
    const settings = this.embeddingOptions;
    const model = typeof settings.model === "string"
      ? { type: "preset", name: settings.model }
      : settings.model;
    const e5 = model.type === "preset" && model.name === "multilingual";
    const vectors = [];
    for (const text of texts) {
      checkSignal(signal);
      const content = e5
        ? `${role === "query" ? "query" : "passage"}: ${text}`
        : text;
      const result = await this.xbergExtract({
        bytes: encoder.encode(content),
        mime: "text/plain",
        filename: "embedding.txt",
      }, {
        disableOcr: true,
        chunking: {
          maxCharacters: Math.max(1, Array.from(content).length + 1),
          overlap: 0,
          embedding: {
            model,
            normalize: true,
            cacheDir: path.join(this.models, "embeddings"),
            acceleration: settings.acceleration,
            maxSequenceLength: settings.maxSequenceLength ?? 512,
          },
        },
      });
      const chunks = result.results.flatMap((document) =>
        document.chunks ?? []
      );
      if (chunks.length !== 1 || !chunks[0].embedding) {
        const warnings = result.results.flatMap((document) =>
          (document.processingWarnings ?? [])
            .filter((warning) => warning.source === "embedding")
            .map((warning) => warning.message)
        );
        throw new RagError(
          "EMBEDDING_RESULT",
          "Xberg did not return one vector per input" +
            (warnings.length ? `: ${[...new Set(warnings)].join("; ")}` : ""),
        );
      }
      vectors.push(Array.from(chunks[0].embedding));
    }
    return { vectors };
  }

  async close() {
    if (this.hookRegistered) {
      (await this.xberg()).unregisterOcrBackend(this.hookName);
    }
  }
}

async function sampleFile(filename, size) {
  const scheme = "sha256:size:first-middle-last:65536";
  const file = await fs.open(filename, "r");
  const digest = createHash("sha256").update(`${scheme}:${size}:`);
  try {
    for (
      const offset of [
        ...new Set([
          0,
          Math.max(0, Math.floor((size - 65536) / 2)),
          Math.max(0, size - 65536),
        ]),
      ]
    ) {
      const bytes = new Uint8Array(Math.min(65536, size - offset));
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead: count } = await file.read(
          bytes,
          read,
          bytes.length - read,
          offset + read,
        );
        if (!count) break;
        read += count;
      }
      digest.update(String(offset)).update(bytes.subarray(0, read));
    }
    return { sample_hash: digest.digest("hex"), sample_scheme: scheme };
  } finally {
    await file.close();
  }
}

function sameStat(document, stat) {
  return document?.size_bytes === stat.size &&
    document.mtime === (stat.mtime?.toISOString() ?? null);
}

async function verifyRevision(
  filename,
  original,
  sample,
  { hash: expectedHash, signal } = {},
) {
  const stat = await fs.stat(filename);
  if (
    stat.size !== original.size ||
    stat.mtime?.getTime() !== original.mtime?.getTime() ||
    (await sampleFile(filename, stat.size)).sample_hash !==
      sample.sample_hash ||
    (expectedHash && expectedHash !== await hashFile(filename, signal))
  ) {
    throw new RagError(
      "FILE_CHANGED",
      "File changed during processing; pending work is retained",
    );
  }
}

function newReport() {
  return {
    scanned: 0,
    unchanged: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    embeddingsGenerated: 0,
    embeddingsReused: 0,
    complete: true,
    errors: [],
  };
}

// Public orchestration owns selection, runtime sources and the two async loops.
export class Rag {
  static async init(options = {}) {
    if (!options.storageDir) throw new TypeError("storageDir is required");
    if (options.storage?.driver && options.storage.driver !== "turso") {
      throw new TypeError("Only Turso Database is supported");
    }
    const rootDir = await fs.realpath(
      localPath(options.rootDir ?? process.cwd(), process.cwd()),
    );
    const storagePath = localPath(options.storageDir, rootDir);
    await fs.mkdir(storagePath, { recursive: true });
    const storageDir = await fs.realpath(storagePath);
    for (const name of ["instance.json", "catalog.json", "lance"]) {
      if (await optional(() => fs.lstat(path.join(storageDir, name)))) {
        throw new RagError(
          "LEGACY_STORAGE",
          "Use a fresh storageDir; existing stores are preserved without migration",
        );
      }
    }
    const lockPath = path.join(storageDir, "writer.lock");
    let lock;
    try {
      lock = await fs.open(lockPath, "wx");
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new RagError(
          "STORAGE_LOCKED",
          "Storage is open or has a stale writer.lock; see README recovery instructions",
        );
      }
      throw error;
    }
    let storage;
    try {
      await lock.write(
        encoder.encode(
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
          }),
        ),
      );
      const limits = limitsFrom(options.indexing);
      const chunking = {
        maxCharacters: options.chunking?.maxCharacters ?? 1200,
        overlap: options.chunking?.overlap ?? 150,
      };
      checkedNumber(chunking.maxCharacters, "chunking.maxCharacters", {
        min: 1,
        integer: true,
      });
      checkedNumber(chunking.overlap, "chunking.overlap", { integer: true });
      if (chunking.overlap >= chunking.maxCharacters) {
        throw new TypeError("Chunk overlap must be smaller than maxCharacters");
      }
      const idleMs = options.worker?.idleMs ?? 1000;
      const retryMs = options.worker?.retryMs ?? 30000;
      checkedNumber(idleMs, "worker.idleMs", { min: 1 });
      checkedNumber(retryMs, "worker.retryMs", { min: 1 });
      const globToRegExp = globalThis.Bun
        ? (pattern) => {
          const glob = new Bun.Glob(pattern);
          return { test: (value) => glob.match(value) };
        }
        : (await imports.glob()).globToRegExp;
      storage = await TursoStorage.open(storageDir);
      await fs.mkdir(path.join(storageDir, "tmp"), { recursive: true });
      const rag = new Rag();
      Object.assign(rag, {
        rootDir,
        storageDir,
        _lock: lock,
        _lockPath: lockPath,
        _storage: storage,
        _globToRegExp: globToRegExp,
        _chunking: chunking,
        _limits: limits,
        _idleMs: idleMs,
        _retryMs: retryMs,
      });
      rag._providers = new ContentProviders({
        rootDir,
        storageDir,
        options,
        limits,
      });
      rag._chunkingKey = hash({ split: 1, ...chunking });
      rag._pipelineKey = hash([
        rag._providers.extractionSignature,
        rag._providers.extractionContext,
        rag._chunkingKey,
        rag._providers.spaceId,
      ]);
      rag._sources = new Map();
      rag._queue = new Map();
      rag._states = new Map();
      rag._operations = new Set();
      rag._context = new AsyncLocalStorage();
      rag._scanTail = Promise.resolve();
      rag._directTail = Promise.resolve();
      rag._abort = new AbortController();
      rag._closed = false;
      await storage.invalidatePipeline(rag._pipelineKey);
      rag._worker = rag._extractLoop();
      return rag;
    } catch (error) {
      try {
        await storage?.close();
      } finally {
        await lock.close();
        await fs.rm(lockPath);
      }
      throw error;
    }
  }

  _operation() {
    if (this._closed) {
      throw new RagError("CLOSED", "Rag instance is closing or closed");
    }
    if (this._context.getStore()?.active) {
      throw new RagError(
        "REENTRANT_CALL",
        "Use hook request data or next(), not public methods on the same instance",
      );
    }
    const completion = Promise.withResolvers();
    this._operations.add(completion.promise);
    return {
      [Symbol.dispose]: () => {
        this._operations.delete(completion.promise);
        completion.resolve();
      },
    };
  }

  _selection(options, root = this.rootDir) {
    return new Selection(root, options, this._globToRegExp);
  }
  _filename(document) {
    return localPath(document.path, this.rootDir);
  }
  _pathKey(filename) {
    return slash(path.relative(this.rootDir, filename));
  }

  _sourceMatches(source, filename) {
    if (!inside(filename, source.path)) return false;
    if (
      !source.hidden &&
      path.relative(source.path, filename).split(path.sep).some((part) =>
        part.startsWith(".")
      )
    ) return false;
    return source.selection.pathMatches(filename);
  }

  _memberships(filename) {
    return [...this._sources.values()].filter((source) =>
      this._sourceMatches(source, filename)
    ).map((source) => source.id);
  }

  _matches(document, selection, includeUnknownMime = false) {
    const filename = this._filename(document);
    return selection.pathMatches(filename) &&
      (selection.mimeMatches(document.mime) ||
        (includeUnknownMime && document.stale && !document.mime)) &&
      (!selection.sourceIds ||
        this._memberships(filename).some((id) =>
          selection.sourceIds.includes(id)
        ));
  }

  _scope(options) {
    const scope = this._selection(options);
    for (const id of scope.sourceIds ?? []) {
      if (!this._sources.has(id)) {
        throw new RagError("SOURCE_NOT_FOUND", `Unknown source ID ${id}`);
      }
    }
    return scope;
  }

  async *_documents(scope) {
    if (scope?.paths) {
      for (const filename of scope.paths) {
        const row = await this._storage.byPath(this._pathKey(filename));
        if (row) yield row;
      }
      return;
    }
    let after = "";
    while (true) {
      const rows = await this._storage.documents({ after });
      for (const row of rows) yield row;
      if (rows.length < 256) break;
      after = rows.at(-1).id;
    }
  }

  async addFolder(value, options = {}) {
    await using _lifetime = this._operation();
    const directory = await fs.realpath(localPath(value, this.rootDir));
    if (
      !(await fs.stat(directory)).isDirectory() ||
      inside(directory, this.storageDir)
    ) throw new TypeError("Source must be a directory outside storageDir");
    if (options.gitignore) {
      throw new RagError(
        "NOT_IMPLEMENTED",
        "Use include/exclude globs; gitignore semantics are not implemented",
      );
    }
    const settings = structuredClone({
      include: options.include ?? ["**/*"],
      exclude: options.exclude ?? [],
      hidden: options.hidden ?? false,
    });
    const selection = this._selection(settings, directory);
    const id = hash(["source", pathToFileURL(directory).href, settings]);
    this._sources.set(id, { id, path: directory, ...settings, selection });
    return { id, path: directory };
  }

  async listFolders() {
    await using _lifetime = this._operation();
    return [...this._sources.values()].map(({ selection: _, ...source }) =>
      structuredClone(source)
    );
  }

  async removeFolder(id) {
    await using _lifetime = this._operation();
    const source = this._sources.get(id);
    if (!source) throw new RagError("SOURCE_NOT_FOUND", "Unknown source ID");
    this._sources.delete(id);
    for await (const document of this._documents()) {
      const filename = this._filename(document);
      if (
        !this._sourceMatches(source, filename) ||
        this._memberships(filename).length
      ) continue;
      const state = this._state(document.id);
      state.token++;
      this._queue.delete(document.id);
      await this._storage.removeDoc(document.id);
      state.outcome = {
        token: state.token,
        status: "removed",
      };
      state.completion.resolve();
    }
  }

  _wake() {
    this._wakeWorker?.();
  }
  _enqueue(
    id,
    { changed = false, from, verify, contentHash, request } = {},
  ) {
    const state = this._state(id);
    if (request && !request.targets.has(id)) {
      request.targets.set(id, state);
      if (request.priority) state.priority++;
    }
    const previous = this._queue.get(id) ??
      (this._active?.id === id ? this._active : null);
    let token = state.token;
    if (changed || !token) {
      if (state.outcome?.token === token) {
        state.completion = Promise.withResolvers();
      }
      token++;
      state.token = token;
      state.retryAt = 0;
    }
    if (previous?.token === token) {
      if (contentHash) previous.contentHash = contentHash;
      if (verify === "hash") previous.verify = "hash";
      return;
    }
    const stages = ["extract", "chunks", "embeddings"];
    if (
      previous?.from &&
      (!from || stages.indexOf(previous.from) < stages.indexOf(from))
    ) from = previous.from;
    this._queue.set(id, {
      id,
      token,
      from,
      runId: request?.runId ?? previous?.runId,
      rebuilt: request?.rebuilt ?? previous?.rebuilt,
      verify: verify ?? previous?.verify ?? "metadata",
      contentHash,
    });
    this._wake();
  }

  _state(id) {
    if (!this._states.has(id)) {
      this._states.set(id, {
        token: 0,
        priority: 0,
        retryAt: 0,
        completion: Promise.withResolvers(),
      });
    }
    return this._states.get(id);
  }

  async _scan(source, scope, report, signal) {
    if (scope.paths) {
      return [...scope.paths].filter((filename) =>
        !inside(filename, this.storageDir) &&
        this._sourceMatches(source, filename) && scope.pathMatches(filename)
      );
    }
    const files = [];
    const visit = async (directory) => {
      checkSignal(signal);
      try {
        for await (const entry of await fs.opendir(directory)) {
          checkSignal(signal);
          const filename = path.join(directory, entry.name);
          if (
            inside(filename, this.storageDir) || entry.isSymbolicLink() ||
            (!source.hidden && entry.name.startsWith("."))
          ) continue;
          if (entry.isDirectory()) await visit(filename);
          else if (
            entry.isFile() && this._sourceMatches(source, filename) &&
            scope.pathMatches(filename)
          ) files.push(filename);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        report.complete = false;
        report.errors.push({ path: directory, ...errorInfo(error) });
      }
    };
    await visit(source.path);
    return files.sort();
  }

  _prepare(options, request) {
    const result = this._scanTail.then(() => this._reconcile(options, request));
    this._scanTail = result.catch(() => {});
    return result;
  }

  async _reconcile(
    {
      scope,
      signal,
      verify = "metadata",
      from,
      retry = false,
      onProgress,
      hints,
    } = {},
    request,
  ) {
    if (!["metadata", "hash"].includes(verify)) {
      throw new TypeError("verify must be metadata or hash");
    }
    const report = newReport();
    request.report = report;
    const files = new Set();
    const absent = [];
    const sourceIds = scope.sourceIds ?? [...this._sources.keys()];
    for (const id of sourceIds) {
      for (
        const filename of await this._scan(
          this._sources.get(id),
          scope,
          report,
          signal,
        )
      ) files.add(filename);
    }
    // Known paths can be checked even after reopen, before sources are supplied.
    for await (const document of this._documents(scope)) {
      if (this._matches(document, scope, true)) {
        files.add(this._filename(document));
      }
    }
    for (const filename of files) {
      if (hints && !hints.some((hint) => inside(filename, hint))) continue;
      checkSignal(signal);
      report.scanned++;
      const pathKey = this._pathKey(filename);
      let document = await this._storage.byPath(pathKey);
      try {
        const stat = await fs.lstat(filename);
        if (
          !stat.isFile() || stat.isSymbolicLink() ||
          inside(filename, this.storageDir)
        ) continue;
        const classification = !document || !sameStat(document, stat)
          ? await this._providers.classify(filename)
          : { mime: document.mime };
        if (classification.mime && !scope.mimeMatches(classification.mime)) {
          continue;
        }
        let changed = !document || !sameStat(document, stat) ||
          (!document.stale && document.pipeline_key !== this._pipelineKey);
        let verifiedHash;
        if (verify === "hash" && document && !changed) {
          verifiedHash = await hashFile(filename, signal);
          const work = this._queue.get(document.id) ??
            (this._active?.id === document.id ? this._active : null);
          changed =
            (work?.contentHash ?? document.content_hash) !== verifiedHash;
        }
        if (changed) {
          document = await this._storage.pending({
            id: document?.id ?? crypto.randomUUID(),
            path: slash(path.relative(this.rootDir, filename)),
            path_key: pathKey,
            mime: classification.mime,
            size_bytes: stat.size,
            mtime: stat.mtime?.toISOString() ?? null,
          });
        }
        if (changed || document.stale || from) {
          if (from && !changed) await this._storage.markStale([document.id]);
          this._enqueue(document.id, {
            changed: changed || Boolean(from) ||
              (retry && Boolean(this._state(document.id).outcome?.error) &&
                !this._queue.has(document.id) &&
                this._active?.id !== document.id),
            from,
            request,
            verify,
            contentHash: verifiedHash,
          });
        } else {
          report.unchanged++;
          await this._storage.checked(document.id);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        if (
          error.code === "ENOENT" && document && report.complete
        ) {
          absent.push(document);
        } else {
          report.complete = false;
          report.errors.push({ path: filename, ...errorInfo(error) });
        }
      }
      if (onProgress) {
        await onProgress({ ...report, errors: undefined, path: filename });
      }
    }
    if (report.complete) {
      for (const document of absent) {
        await this._storage.markStale([document.id]);
        this._enqueue(document.id, { changed: true, verify, request });
      }
    }
    return report;
  }

  async _awaitTargets(request, signal) {
    signal = AbortSignal.any([this._abort.signal, ...(signal ? [signal] : [])]);
    const interrupted = Promise.withResolvers();
    signal.onabort = () => interrupted.resolve();
    const states = [...request.targets.values()];
    let outcomes;
    try {
      checkSignal(signal);
      do {
        outcomes = await Promise.all(states.map(async (state) => {
          while (state.outcome?.token !== state.token) {
            await Promise.race([state.completion.promise, interrupted.promise]);
            checkSignal(signal);
          }
          return state.outcome;
        }));
      } while (
        outcomes.some((outcome, index) => outcome.token !== states[index].token)
      );
    } finally {
      signal.onabort = null;
    }
    const report = request.report;
    for (const outcome of outcomes) {
      if (outcome.status === "error" || outcome.status === "skipped") {
        report[outcome.status === "error" ? "failed" : "skipped"]++;
        report.complete = false;
        report.errors.push({ path: outcome.path, ...outcome.error });
      } else report[outcome.status]++;
      report.embeddingsGenerated += outcome.embeddingsGenerated ?? 0;
      report.embeddingsReused += outcome.embeddingsReused ?? 0;
    }
    return report;
  }

  _request(priority = false) {
    const targets = new Map();
    return {
      priority,
      targets,
      runId: crypto.randomUUID(),
      rebuilt: new Set(),
      [Symbol.dispose]() {
        if (priority) {
          for (const state of targets.values()) state.priority--;
        }
      },
    };
  }

  async index(options = {}) {
    await using _lifetime = this._operation();
    if (options.refresh !== undefined) {
      throw new TypeError(
        "index always reconciles its scope; refresh belongs to search",
      );
    }
    using request = this._request();
    await this._prepare({
      ...options,
      scope: this._scope(options.scope),
      retry: true,
    }, request);
    return await this._awaitTargets(request, options.signal);
  }

  async reindex({ from = "extract", ...options } = {}) {
    if (!["extract", "chunks", "embeddings", "indexes"].includes(from)) {
      return Promise.reject(new TypeError("Unknown reindex stage"));
    }
    if (from !== "indexes") return this.index({ ...options, from });
    await using _lifetime = this._operation();
    if (options.scope) {
      throw new TypeError(
        "Physical index rebuilding applies to the entire storage",
      );
    }
    checkSignal(options.signal);
    return await this._storage.rebuild();
  }

  async _idle() {
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this._wakeWorker = null;
        resolve();
      };
      const timer = setTimeout(finish, this._idleMs);
      this._wakeWorker = finish;
      if (this._closed) finish();
    });
  }

  async _extractLoop() {
    let after = "";
    while (!this._closed) {
      try {
        if (this._maintenance) {
          await this._idle();
          continue;
        }
        if (!this._queue.size) {
          const rows = await this._storage.documents({
            stale: true,
            after,
            limit: 100,
          });
          after = rows.length === 100 ? rows.at(-1).id : "";
          for (const row of rows) {
            if (this._state(row.id).retryAt > Date.now()) {
              continue;
            }
            this._enqueue(row.id);
          }
        }
        let item;
        for (const candidate of this._queue.values()) {
          const state = this._state(candidate.id);
          if (state.retryAt > Date.now()) continue;
          item ??= candidate;
          if (state.priority) {
            item = candidate;
            break;
          }
        }
        if (this._maintenance) continue;
        if (!item) {
          await this._idle();
          continue;
        }
        this._queue.delete(item.id);
        this._active = item;
        const state = this._state(item.id);
        let outcome;
        try {
          outcome = await this._update(item);
        } catch (error) {
          if (this._closed) break;
          const failedDoc = await this._storage.doc(item.id);
          outcome = {
            status: error instanceof SkipFile ? "skipped" : "error",
            error: errorInfo(error),
            path: failedDoc ? this._filename(failedDoc) : undefined,
          };
          if (state.token === item.token) {
            state.retryAt = Date.now() + this._retryMs;
          }
        }
        if (
          outcome && state.token === item.token
        ) {
          state.outcome = { ...outcome, token: item.token };
          state.completion.resolve();
        }
        this._active = null;
      } catch (error) {
        if (this._closed) break;
        this._workerError = errorInfo(error);
        await this._idle();
      }
    }
    this._active = null;
  }

  async _update(item) {
    const document = await this._storage.doc(item.id);
    if (!document) return { status: "removed" };
    const filename = this._filename(document);
    const signal = this._abort.signal;
    const before = await optional(() => fs.lstat(filename));
    if (!before) {
      await this._storage.removeDoc(document.id);
      return { status: "removed", path: filename };
    }
    if (
      !before.isFile() || before.isSymbolicLink() ||
      inside(filename, this.storageDir)
    ) {
      throw new SkipFile(
        "NOT_REGULAR_FILE",
        "Source is not an eligible regular file",
      );
    }
    const classification = await this._providers.classify(filename);
    const limit = classification.mediaType
      ? this._limits[classification.mediaType].maxFileBytes
      : this._limits.maxFileBytes;
    if (before.size > limit) {
      throw new SkipFile("MAX_FILE_BYTES", `File exceeds ${limit} bytes`);
    }
    const fingerprint = await sampleFile(filename, before.size);
    const contentHash = item.verify !== "hash" && document.content_hash &&
        sameStat(document, before) &&
        document.sample_hash === fingerprint.sample_hash
      ? document.content_hash
      : await hashFile(filename, signal);
    item.contentHash = contentHash;
    const contextKey = hash([
      this._providers.extractionContext,
      this._providers.extractionContext === "path"
        ? filename
        : this._providers.extractionContext === "filename"
        ? path.basename(filename)
        : path.extname(filename).toLowerCase(),
      classification.mime,
    ]);
    const baseKey = hash([
      contentHash,
      this._providers.extractionSignature,
      contextKey,
    ]);
    let data = await this._storage.data(baseKey);
    const forcedId = item.from === "extract"
      ? hash([baseKey, item.runId])
      : null;
    if (!data || (forcedId && data.id !== forcedId)) {
      const extracted = await this._context.run(
        { active: true },
        () =>
          this._providers.extract({
            input: {
              path: filename,
              filename: path.basename(filename),
              mime: classification.mime,
            },
            classification,
            document: { id: document.id, path: filename },
            signal,
          }),
      );
      await verifyRevision(filename, before, fingerprint);
      data = {
        ...extracted,
        id: forcedId ?? baseKey,
        base_key: baseKey,
        content_hash: contentHash,
        extraction_key: this._providers.extractionSignature,
        context_key: contextKey,
        mime: extracted.mime ?? classification.mime ??
          "application/octet-stream",
      };
      await this._storage.putData(data);
    }
    const chunks = new Map();
    const links = [];
    const space = this._providers.spaceId ?? "";
    const add = (unit, unitIndex, owner) => {
      for (const part of splitText(unit.text, this._chunking)) {
        const payloadHash = hash(["text", part.text]);
        const inputHash = hash(["document", part.text]);
        const chunkId = hash([payloadHash, space, inputHash]);
        chunks.set(chunkId, {
          id: chunkId,
          payload_hash: payloadHash,
          payload_kind: "text",
          text: part.text,
          input_hash: inputHash,
          embedding_key: space,
          embedding_config: this._providers.embeddingConfig,
        });
        const locator = unit.locator ?? {};
        const language = unit.language ?? null;
        const link = {
          ...owner,
          chunk_id: chunkId,
          chunking_key: this._chunkingKey,
          ordinal: links.length,
          unit_index: unitIndex,
          start: part.start,
          end: part.end,
          kind: unit.kind ?? (owner.user_meta_id ? "note" : "text"),
          origin: unit.origin ??
            (owner.user_meta_id
              ? "manual"
              : locator.channel === "audio"
              ? "asr"
              : locator.channel === "video-ocr" ||
                  data.mime.startsWith("image/")
              ? "ocr"
              : "parser"),
          language,
          language_source: unit.language_source ?? unit.languageSource ?? null,
          programming_language: unit.programming_language ?? null,
          unit_mime: unit.mime ?? locator.mime ?? data.mime,
          page_start: locator.page ?? null,
          page_end: locator.page ?? null,
          time_start_ms: locator.start === undefined
            ? null
            : locator.start * 1000,
          time_end_ms: locator.end === undefined ? null : locator.end * 1000,
          locator,
          metadata: unit.metadata ?? {},
        };
        link.id = hash([
          document.id,
          owner,
          this._chunkingKey,
          link.ordinal,
          chunkId,
          locator,
        ]);
        links.push(link);
      }
    };
    for (const [index, unit] of data.units.entries()) {
      add(unit, index, { data_id: data.id });
    }
    for (
      const meta of await this._storage.metadata({ documentId: document.id })
    ) {
      add(
        {
          text: meta.value,
          kind: meta.type,
          origin: "manual",
          locator: { userMetaId: meta.id },
        },
        0,
        {
          user_meta_id: meta.id,
          user_meta_input_hash: hash([meta.type, meta.value]),
        },
      );
    }
    if (this._closed || this._state(item.id).token !== item.token) return null;
    const existing = new Map(
      (await this._storage.chunks([...chunks.keys()])).map((
        row,
      ) => [row.id, row]),
    );
    const missing = space
      ? [...chunks.values()].filter((chunk) =>
        !existing.get(chunk.id)?.embedded ||
        (item.from === "embeddings" && !item.rebuilt?.has(chunk.id))
      )
      : [];
    if (missing.length) {
      const { vectors } = await this._context.run(
        { active: true },
        () =>
          this._providers.embed(
            missing.map((chunk) => chunk.text),
            { signal },
          ),
      );
      vectorsChecked(
        vectors,
        missing.length,
        await this._storage.dimensions(space),
      );
      missing.forEach((chunk, index) => {
        chunk.vector = vectors[index];
      });
    }
    checkSignal(signal);
    await verifyRevision(filename, before, fingerprint, {
      hash: item.verify === "hash" ? contentHash : undefined,
      signal,
    });
    const isCurrent = () =>
      !this._closed && this._state(item.id).token === item.token;
    if (!isCurrent()) return null;
    await this._storage.publish(
      {
        ...document,
        ...fingerprint,
        mime: data.mime,
        size_bytes: before.size,
        mtime: before.mtime?.toISOString() ?? null,
        content_hash: contentHash,
        data_id: data.id,
        pipeline_key: this._pipelineKey,
      },
      [...chunks.values()],
      links,
      isCurrent,
    );
    if (!isCurrent()) {
      await this._storage.markStale([document.id]);
      return null;
    }
    for (const chunk of missing) item.rebuilt?.add(chunk.id);
    return {
      status: "updated",
      path: filename,
      embeddingsGenerated: missing.length,
      embeddingsReused: space ? chunks.size - missing.length : 0,
    };
  }
  async search(query, options = {}) {
    await using _lifetime = this._operation();
    if (typeof query !== "string" || !query.trim()) {
      throw new TypeError("Search query must be a nonempty string");
    }
    const {
      refresh = "background",
      mode: requestedMode = "auto",
      limit = 10,
      signal,
    } = options;
    if (!["background", "wait", "none"].includes(refresh)) {
      throw new TypeError("refresh must be background, wait or none");
    }
    if (!["auto", "fulltext", "vector", "hybrid"].includes(requestedMode)) {
      throw new TypeError("Unknown search mode");
    }
    checkedNumber(limit, "search.limit", { min: 1, integer: true });
    const filters = {};
    for (const key of ["kinds", "origins", "languages"]) {
      filters[key] = stringList(options.scope?.[key], `scope.${key}`);
    }
    checkSignal(signal);
    const scope = this._scope(options.scope);
    using request = this._request(refresh === "wait");
    if (refresh !== "none") {
      await this._prepare({ ...options, scope }, request);
      if (refresh === "wait") await this._awaitTargets(request, signal);
    }
    const documentIds = [];
    const pendingIds = new Set();
    for await (const doc of this._documents(scope)) {
      if (!this._matches(doc, scope, true)) continue;
      if (doc.data_id) documentIds.push(doc.id);
      if (doc.stale) pendingIds.add(doc.id);
    }
    for (const id of request.targets.keys()) {
      if (!pendingIds.has(id) && (await this._storage.doc(id))?.stale) {
        pendingIds.add(id);
      }
    }
    const embeddingKey = this._providers.spaceId;
    const dimensions = embeddingKey
      ? await this._storage.dimensions(embeddingKey)
      : undefined;
    const mode = requestedMode === "auto"
      ? (dimensions ? "hybrid" : "fulltext")
      : requestedMode;
    let vector;
    if (mode !== "fulltext") {
      if (!embeddingKey) {
        throw new RagError(
          "EMBEDDING_DISABLED",
          "Vector search requires embeddings",
        );
      }
      if (documentIds.length) {
        const result = await this._context.run(
          { active: true },
          () => this._providers.embed([query], { role: "query", signal }),
        );
        [vector] = vectorsChecked(result.vectors, 1, dimensions);
      }
    }
    const rows = documentIds.length
      ? await this._storage.retrieve({
        query,
        documentIds,
        mode,
        vector,
        embeddingKey,
        limit,
        filters,
      })
      : [];
    checkSignal(signal);
    const hits = rows.map((row) => {
      return {
        chunkId: row.id,
        text: row.text,
        payloadKind: row.payload_kind,
        assetRef: row.asset_ref,
        score: row.score,
        citations: row.citations.map((link) => {
          const filename = localPath(link.path, this.rootDir);
          const memberships = this._memberships(filename);
          return {
            documentId: link.doc_id,
            dataId: link.data_id,
            userMetaId: link.user_meta_id,
            occurrenceId: link.id,
            path: filename,
            relativePath: link.path,
            uri: pathToFileURL(filename).href,
            mime: link.mime,
            stale: Boolean(link.stale),
            sourceIds: scope.sourceIds
              ? memberships.filter((id) => scope.sourceIds.includes(id))
              : memberships,
            ordinal: link.ordinal,
            start: link.start_offset,
            end: link.end_offset,
            offsetUnit: "utf8-bytes",
            kind: link.kind,
            origin: link.origin,
            language: link.language,
            languageSource: link.language_source,
            programmingLanguage: link.programming_language,
            unitMime: link.unit_mime,
            pageStart: link.page_start,
            pageEnd: link.page_end,
            timeStartMs: link.time_start_ms,
            timeEndMs: link.time_end_ms,
            locator: link.locator,
            metadata: link.metadata,
          };
        }),
      };
    });
    return {
      hits,
      mode,
      refresh: request.report,
      freshness: {
        checked: refresh !== "none",
        staleDetected: refresh === "none" ? null : request.targets.size,
        pending: pendingIds.size,
        complete: refresh === "none"
          ? null
          : Boolean(request.report.complete && !pendingIds.size),
      },
    };
  }

  async listDocuments({ scope: options, limit = 100, after = "" } = {}) {
    await using _lifetime = this._operation();
    checkedNumber(limit, "listDocuments.limit", { min: 1, integer: true });
    const scope = this._scope(options);
    const documents = [];
    let cursor = after;
    while (documents.length < limit) {
      const rows = await this._storage.documents({
        after: cursor,
        limit: Math.min(256, limit - documents.length),
      });
      if (!rows.length) break;
      cursor = rows.at(-1).id;
      documents.push(
        ...rows.filter((row) => this._matches(row, scope)).map((row) => ({
          ...row,
          stale: Boolean(row.stale),
        })),
      );
    }
    return { documents, after: cursor };
  }

  async _direct(operation) {
    await using _lifetime = this._operation();
    const result = this._directTail.then(() =>
      this._context.run({ active: true }, operation)
    );
    this._directTail = result.catch(() => {});
    return await result;
  }

  embed(texts, options = {}) {
    return this._direct(() => {
      if (
        !Array.isArray(texts) ||
        texts.some((text) => typeof text !== "string" || !text.trim())
      ) throw new TypeError("embed expects an array of nonempty strings");
      if (!texts.length) {
        return { spaceId: this._providers.spaceId, vectors: [] };
      }
      return this._providers.embed(texts, options);
    });
  }

  transcribe(input, options = {}) {
    return this._direct(() =>
      this._providers.transcribe({
        input: this._providers.input(input),
        options,
        signal: options.signal,
      })
    );
  }

  ocr(input, options = {}) {
    return this._direct(async () => {
      const normalized = this._providers.input(input);
      if (normalized.path) {
        normalized.bytes = await fs.readFile(normalized.path);
      }
      normalized.mime ??= options.mime ?? "image/png";
      return await this._providers.ocr({
        input: normalized,
        options,
        signal: options.signal,
      });
    });
  }

  async _meta(options) {
    await using _lifetime = this._operation();
    if (
      options.type !== undefined &&
      (typeof options.type !== "string" || !options.type.trim())
    ) throw new TypeError("Metadata type must be nonempty text");
    if (options.value !== undefined && typeof options.value !== "string") {
      throw new TypeError("Metadata value must be text");
    }
    const result = await this._storage.mutateMeta(options);
    for (const id of result.affected) this._enqueue(id, { changed: true });
    return { id: result.id };
  }

  addUserMeta({ type = "note", value, documentIds = [] }) {
    if (typeof value !== "string") {
      return Promise.reject(new TypeError("Metadata value must be text"));
    }
    return this._meta({
      action: "add",
      id: crypto.randomUUID(),
      type,
      value,
      documentIds,
    });
  }
  updateUserMeta(id, { type, value }) {
    return this._meta({ action: "update", id, type, value });
  }
  removeUserMeta(id) {
    return this._meta({ action: "remove", id });
  }
  linkUserMeta(documentId, id) {
    return this._meta({ action: "link", id, documentIds: [documentId] });
  }
  unlinkUserMeta(documentId, id) {
    return this._meta({ action: "unlink", id, documentIds: [documentId] });
  }
  async listUserMeta(options = {}) {
    await using _lifetime = this._operation();
    return await this._storage.metadata(options);
  }

  async status() {
    await using _lifetime = this._operation();
    const counts = await this._storage.counts();
    counts.sources = this._sources.size;
    const errors = [];
    let prioritized = 0;
    for (const [id, state] of this._states) {
      if (state.outcome?.error) {
        errors.push({ documentId: id, ...state.outcome.error });
      }
      if (state.priority) prioritized++;
    }
    return {
      version: VERSION,
      rootDir: this.rootDir,
      storageDir: this.storageDir,
      storage: this._storage.capabilities,
      indexing: structuredClone(this._limits),
      counts,
      states: { ready: counts.documents - counts.stale, stale: counts.stale },
      worker: {
        active: this._active?.id ?? null,
        queued: this._queue.size,
        prioritized,
        error: this._workerError,
      },
      spaceId: this._providers.spaceId,
      errors,
      ocr: {
        mode: this._providers.ocrOptions.mode,
        languages: this._providers.ocrOptions.languages,
        universalLanguageDetection: false,
        autoCoverage: this._providers.ocrOptions.mode === "paddle"
          ? [
            "Simplified Chinese",
            "Traditional Chinese",
            "English",
            "Japanese",
            "46 Latin-script languages",
          ]
          : [],
      },
    };
  }

  async gc() {
    await using _lifetime = this._operation();
    // Protect prepared reusable artifacts until the active ingestion finishes.
    // Search remains independent; GC is explicit maintenance.
    if (this._active || this._queue.size) {
      throw new RagError("WORK_PENDING", "Run GC when ingestion is idle");
    }
    this._maintenance = true;
    try {
      return await this._storage.gc();
    } finally {
      this._maintenance = false;
      this._wake();
    }
  }

  async watch({ debounceMs = 500, onReport, onError, scope } = {}) {
    await using _lifetime = this._operation();
    checkedNumber(debounceMs, "watch.debounceMs");
    if (this._watchHandle) {
      throw new RagError(
        "ALREADY_WATCHING",
        "Only one watch loop is allowed per instance",
      );
    }
    const selection = this._scope(scope);
    const roots = [
      ...new Set(
        [...this._sources.values()]
          .filter((source) =>
            !selection.sourceIds || selection.sourceIds.includes(source.id)
          ).map((source) => source.path),
      ),
    ];
    if (!roots.length) {
      throw new RagError("NO_SOURCES", "Register a folder before watching");
    }
    const watchers = [];
    let stopped = false;
    let timer;
    const hints = new Set();
    const run = () => {
      if (stopped || this._closed) return;
      const paths = [...hints];
      hints.clear();
      (async () => {
        await using _lifetime = this._operation();
        const request = this._request();
        const report = await this._prepare({
          scope: selection,
          hints: paths,
          verify: "hash",
        }, request);
        await onReport?.({
          ...report,
          scheduled: request.targets.size,
        });
      })().catch((error) => {
        if (onError) onError(error);
        else console.error("rag.js watch:", error);
      });
    };
    const failed = (error) => {
      if (stopped || this._closed) return;
      if (onError) onError(error);
      else console.error("rag.js watch:", error);
    };
    try {
      for (const root of roots) {
        const watcher = watchDirectory(
          root,
          { recursive: true },
          (_, relative) => {
            if (stopped || this._closed) return;
            const filename = path.resolve(root, relative?.toString() ?? ".");
            if (inside(filename, this.storageDir)) return;
            hints.add(filename);
            clearTimeout(timer);
            timer = setTimeout(run, debounceMs);
          },
        );
        watchers.push(watcher);
        watcher.on("error", failed);
      }
    } catch (error) {
      for (const watcher of watchers) watcher.close();
      throw error;
    }
    const handle = {
      close: () => {
        if (stopped) return Promise.resolve();
        stopped = true;
        clearTimeout(timer);
        for (const watcher of watchers) watcher.close();
        this._watchHandle = null;
        return Promise.resolve();
      },
    };
    this._watchHandle = handle;
    return handle;
  }

  close() {
    if (this._context.getStore()?.active) {
      return Promise.reject(
        new RagError("REENTRANT_CALL", "Close outside provider hooks"),
      );
    }
    if (this._closing) return this._closing;
    this._closed = true;
    this._abort.abort(new RagError("CLOSED", "Rag instance is closing"));
    this._wake();
    this._closing = (async () => {
      try {
        await this._watchHandle?.close();
        await Promise.all([...this._operations]);
        await this._worker;
        await this._providers.close();
        await this._storage.close();
      } finally {
        await this._lock.close();
        await fs.rm(this._lockPath);
      }
    })();
    return this._closing;
  }
}
