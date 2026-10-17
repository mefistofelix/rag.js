// Public fixtures and aggregate metrics only. Keep private outputs under build/.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const report = JSON.parse(
  await Deno.readTextFile("build/indra-test/results.json"),
);
const digest = async (name) =>
  createHash("sha256").update(await Deno.readFile(name)).digest("hex");
assert.equal(report.productSha256, await digest("rag.js"));
const core = JSON.parse(
  await Deno.readTextFile("build/results/core-contracts-v2.json"),
);
assert.equal(core.productSha256, report.productSha256);
assert.equal(core.failed, 0);
const native = JSON.parse(
  await Deno.readTextFile("build/results/rag-native-v2-default.json"),
)[0];
assert.equal(native.productSha256, report.productSha256);
assert.equal(native.report.failed, 0);
report.verification = {
  coreContracts: { passed: core.passed, failed: core.failed },
  native: {
    indexed: native.report.updated,
    channels: native.searchableChannels,
    elementaryVideo: native.elementaryVideo.indexed,
  },
};
for (const [name, sha256] of Object.entries(report.experimentSha256)) {
  assert.equal(
    sha256,
    await digest(name),
    `Run benchmark indra again after changing ${name}`,
  );
}
assert.ok(
  report.reference,
  "Run build.bat indra-reference before benchmark indra",
);
assert.equal(report.reference.fixtures.length, 10);
for (const result of report.results) {
  assert.equal(result.retrievalPaths, 3);
  if (result.provider === "paddle") continue;
  assert.equal(result.pdfRouting.textPdfSkipsOcr, true);
  assert.equal(result.pdfRouting.scannedPdfUsesHook, true);
  assert.ok(
    result.fixtures.filter((row) => row.id !== "ar").every((row) =>
      row.cerNoWhitespace < 0.15
    ),
  );
}
await Deno.writeTextFile(
  "reports/indra-2026-10-16.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log("Published reports/indra-2026-10-16.json");
