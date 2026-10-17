// Real PDF routing and content-MIME checks; the OCR spy avoids model timing noise.
import assert from "node:assert/strict";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Rag } from "../rag.js";

const directory = path.resolve("build/xp", crypto.randomUUID().slice(0, 6));
await Deno.mkdir(directory, { recursive: true });
const imageFile = path.resolve("build/native-rag/scan.jpg");
const image = Buffer.from(await Deno.readFile(imageFile)).toString("latin1");
const sentence =
  "The library contains books about science and history. Please return the documents before Friday morning. The contract includes twenty pages and a final signature.";
async function pdf(name, pageKinds, smallImage = false) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const imageId = objects.push(
    `<< /Type /XObject /Subtype /Image /Width 2000 /Height 550 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n${image}\nendstream`,
  );
  const pages = [];
  for (const kind of pageKinds) {
    const text = kind !== "scan"
      ? `BT /F1 12 Tf 20 740 Td (${sentence}) Tj 0 -20 Td (${sentence}) Tj ET\n`
      : "";
    const picture = kind !== "native"
      ? `q ${
        smallImage ? "200 0 0 100 40 400" : "612 0 0 792 0 0"
      } cm /Im1 Do Q\n`
      : "";
    const stream = picture + text;
    const contentId = objects.push(
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    );
    pages.push(
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${
    pages.map((id) => `${id} 0 R`).join(" ")
  }] /Count ${pages.length} >>`;
  const infoId = objects.push(
    "<< /Title (Public routing fixture) /Author (rag.js tests) >>",
  );
  let document = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(document.length);
    document += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = document.length;
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document +=
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const filename = path.join(directory, name);
  await Deno.writeFile(filename, Buffer.from(document, "latin1"));
  return filename;
}
let calls = 0;
const rag = await Rag.init({
  storageDir: path.join(directory, "s"),
  embedding: false,
  transcribe: false,
  ocr: () => {
    calls++;
    return { text: sentence, provider: "routing-spy" };
  },
  hookVersion: { ocr: "routing-spy-v1" },
});
const rows = [];
try {
  for (
    const [name, kinds, small] of [
      ["native.pdf", ["native"], false],
      ["overlay.pdf", ["overlay"], false],
      ["scan.pdf", ["scan"], false],
      ["mixed.pdf", ["overlay", "scan"], false],
      ["small.pdf", ["overlay"], true],
    ]
  ) {
    const filename = await pdf(name, kinds, small);
    const before = calls, started = performance.now();
    const result = await rag._providers.extract({
      input: { path: filename, filename: name },
    });
    const row = {
      name,
      ocrCalls: calls - before,
      ms: performance.now() - started,
      pages: result.units.length,
      metadata: result.units[0].locator.metadata,
    };
    assert.equal(result.mime, "application/pdf");
    assert.equal(row.metadata.title, "Public routing fixture");
    assert.ok(result.units.every((unit) => unit.text.includes("library")));
    rows.push(row);
  }
  assert.equal(rows[0].ocrCalls, 0);
  assert.equal(
    rows[1].ocrCalls,
    0,
    "Do not OCR a full-page image repeating a usable native text layer",
  );
  assert.ok(rows[2].ocrCalls > 0);
  assert.equal(
    rows[3].ocrCalls,
    rows[2].ocrCalls,
    "Only the scanned page needs OCR in the mixed PDF",
  );
  assert.ok(
    rows[4].ocrCalls > 0,
    "An illustration can contain additional text absent from the page layer",
  );
  const manifest = JSON.parse(
    await Deno.readTextFile("build/xc/manifest.json"),
  );
  const renamed = [];
  for (
    const [type, extension, mime] of [
      ["pdf", ".txt", "application/pdf"],
      [
        "docx",
        ".txt",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      ["zip", ".pdf", "application/zip"],
      ["png", ".pdf", "image/png"],
    ]
  ) {
    const fixture = manifest.fixtures.find((fixture) =>
      fixture.type === type && !fixture.unavailable
    );
    const filename = path.join(directory, `renamed-${type}${extension}`);
    assert.ok(fixture || type === "png", type);
    await Deno.copyFile(fixture?.filename ?? "build/fixtures/en.png", filename);
    const result = await rag._providers.extract({
      input: { path: filename, filename: path.basename(filename) },
    });
    assert.equal(result.mime, mime);
    renamed.push({
      type,
      extension,
      mime: result.mime,
      metadataKeys: Object.keys(result.units[0].locator?.metadata ?? {}),
    });
  }
  await Deno.mkdir("build/results", { recursive: true });
  await Deno.writeTextFile(
    "build/results/xberg-policy.json",
    JSON.stringify(
      {
        target: `${Deno.build.os}/${Deno.build.arch}`,
        xberg: "1.3.10",
        sourceSha256: createHash("sha256").update(await Deno.readFile("rag.js"))
          .digest("hex"),
        rows,
        renamed,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      pdfCases: rows.map(({ name, ocrCalls }) => ({ name, ocrCalls })),
      renamed,
    }),
  );
} finally {
  await rag.close();
}
const builtin = await Rag.init({
  storageDir: path.join(directory, "b"),
  embedding: false,
  transcribe: false,
});
try {
  const filename = path.resolve("build/fixtures/en.png");
  const extracted = await builtin._providers.extract({
    input: { path: filename, filename: "en.png" },
  });
  const metadata = extracted.units[0].locator.metadata;
  assert.ok(
    Object.keys(metadata).length > 0,
    "Preserve image metadata already returned by native OCR extraction",
  );
  console.log(
    JSON.stringify({ builtinImageMetadataKeys: Object.keys(metadata) }),
  );
  const result = JSON.parse(
    await Deno.readTextFile("build/results/xberg-policy.json"),
  );
  result.builtinImageMetadata = metadata;
  await Deno.writeTextFile(
    "build/results/xberg-policy.json",
    JSON.stringify(result, null, 2),
  );
} finally {
  await builtin.close();
}
