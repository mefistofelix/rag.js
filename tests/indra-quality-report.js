// Keep the measured default-selection comparison separate from the clean test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clean = (text) =>
  Array.from(
    text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
  );
function cer(expected, actual) {
  const a = clean(expected), b = clean(actual);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
    }
    previous = current;
  }
  return previous[b.length] / Math.max(1, a.length);
}
const report = JSON.parse(
  await Deno.readTextFile("build/indra-quality/results.json"),
);
assert.equal(report.productSha256, digest(await Deno.readFile("rag.js")));
for (const [name, sha256] of Object.entries(report.experimentSha256)) {
  assert.equal(sha256, digest(await Deno.readFile(name)));
}
assert.equal(report.results.length, 2);
for (const result of report.results) {
  assert.equal(result.rows.length, 21);
  assert.equal(result.summary.cases, 21);
}
const reference = JSON.parse(
  await Deno.readTextFile("build/indra-quality/python-reference.json"),
);
const fixtures = JSON.parse(
  await Deno.readTextFile("build/indra-quality/fixtures/manifest.json"),
);
assert.equal(reference.rows.length, 21);
assert.equal(reference.modelRevision, report.models.revision);
const referenceRows = fixtures.map((fixture) => {
  const row = reference.rows.find((item) => item.id === fixture.id);
  const tested = report.results[0].rows.find((item) => item.id === fixture.id);
  assert.equal(row.imageSha256, tested.imageSha256);
  return {
    id: row.id,
    cerNoWhitespace: cer(fixture.text, row.text),
    warmMedianMs: row.warmMedianMs,
  };
});
report.reference = {
  indra: reference.indra,
  python: reference.python,
  onnxruntime: reference.onnxruntime,
  scriptSha256: digest(await Deno.readFile("tests/indra_reference.py")),
  exactCases: referenceRows.filter((row) => row.cerNoWhitespace === 0).length,
  meanCer: referenceRows.reduce((sum, row) => sum + row.cerNoWhitespace, 0) /
    referenceRows.length,
  rows: referenceRows,
  note:
    "Full upstream Python pipeline includes deskew/layout, unlike the actual JS candidate. It is an oracle, not a shipped provider.",
};
report.decision = {
  default: "paddle",
  candidate: "experimental Indra JS CPU",
  reason:
    "Candidate is faster but loses exact text, searchable anchors, inclined-page recognition and Japanese coverage on this diagnostic set. The condition for replacing the general default was not met.",
  scope:
    "The actual JS implementation, not the complete upstream Indra pipeline. No universal engine ranking is claimed.",
};
await Deno.writeTextFile(
  "reports/indra-quality-2026-10-16.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log("Published reports/indra-quality-2026-10-16.json");
