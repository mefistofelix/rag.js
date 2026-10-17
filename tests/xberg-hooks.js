// Verify the published JS embedding plugin bridge, without models or GPU claims.
import assert from "node:assert/strict";
import * as xberg from "npm:@xberg-io/xberg@1.3.10";

const names = [0, 1].map((i) => `rag-test-${crypto.randomUUID()}-${i}`);
const calls = [[], []];
const registered = [];
try {
  for (const [index, name] of names.entries()) {
    xberg.registerEmbeddingBackend({
      name: () => name,
      version: () => "1",
      initialize() {},
      shutdown() {},
      dimensions: () => 3,
      embed: async (texts) => {
        await Promise.resolve();
        calls[index].push(...texts);
        return texts.map(() => index === 0 ? [1, 0, 0] : [0, 1, 0]);
      },
    });
    registered.push(name);
  }
  const run = (name) =>
    xberg.extract({
      kind: "bytes",
      bytes: new TextEncoder().encode("A library contains history books."),
      mimeType: "text/plain",
    }, {
      disableOcr: true,
      useCache: false,
      chunking: {
        maxCharacters: 1000,
        overlap: 0,
        embedding: { model: { type: "plugin", name }, normalize: true },
      },
    });
  for (const [index, name] of names.entries()) {
    const result = await run(name);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(
      result.results[0].chunks[0].embedding,
      index === 0 ? [1, 0, 0] : [0, 1, 0],
    );
    assert.ok(calls[index].length > 0);
  }
  xberg.unregisterEmbeddingBackend(names[0]);
  registered.shift();
  assert.ok(xberg.listEmbeddingBackends().includes(names[1]));
  assert.equal((await run(names[1])).results[0].chunks[0].embedding[1], 1);
  console.log(
    "Xberg async JS embedding plugin dispatch and independent unregister passed; GPU execution is not tested here.",
  );
  await Deno.mkdir("build/results", { recursive: true });
  await Deno.writeTextFile(
    "build/results/xberg-hooks.json",
    JSON.stringify(
      {
        deno: Deno.version,
        target: Deno.build,
        asyncEmbeddingDispatch: true,
        independentUnregister: true,
        gpuInferenceTested: false,
      },
      null,
      2,
    ),
  );
} finally {
  for (const name of registered) xberg.unregisterEmbeddingBackend(name);
}
