import * as path from "node:path";

// Public FLEURS speech fixtures, CC BY 4.0. Read only the first suitable TAR
// member, then cancel the HTTP stream; do not download the whole audio corpus.
const directory = path.resolve("build/fixtures");
const manifestPath = path.join(directory, "manifest.json");
const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
for (
  const [language, config] of [["ru", "ru_ru"], ["zh", "cmn_hans_cn"], [
    "de",
    "de_de",
  ]]
) {
  if (manifest.some((entry) => entry.id === `speech-${language}`)) continue;
  const base =
    `https://huggingface.co/datasets/google/fleurs/resolve/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/${config}`;
  const tsvResponse = await fetch(`${base}/test.tsv`);
  if (!tsvResponse.ok) throw new Error(`FLEURS TSV ${tsvResponse.status}`);
  const transcripts = new Map(
    (await tsvResponse.text()).trim().split("\n").map((line) => {
      const fields = line.split("\t");
      return [fields[1], fields[2]];
    }),
  );
  const response = await fetch(`${base}/audio/test.tar.gz`);
  if (!response.ok) throw new Error(`FLEURS TAR ${response.status}`);
  const reader = response.body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  let buffered = new Uint8Array();
  const take = async (length) => {
    while (buffered.length < length) {
      const part = await reader.read();
      if (part.done) throw new Error("Unexpected end of TAR");
      const combined = new Uint8Array(buffered.length + part.value.length);
      combined.set(buffered);
      combined.set(part.value, buffered.length);
      buffered = combined;
    }
    const output = buffered.slice(0, length);
    buffered = buffered.slice(length);
    return output;
  };
  try {
    for (let i = 0; i < 25; i++) {
      const header = await take(512);
      const decoder = new TextDecoder();
      const filename = decoder.decode(header.subarray(0, 100)).replace(
        /\0.*$/s,
        "",
      );
      const size = parseInt(
        decoder.decode(header.subarray(124, 136)).replace(/\0.*$/s, "")
          .trim(),
        8,
      ) || 0;
      const bytes = await take(Math.ceil(size / 512) * 512);
      const basename = filename.split("/").at(-1);
      if (!transcripts.has(basename)) continue;
      const output = `speech-${language}.wav`;
      await Deno.writeFile(
        path.join(directory, output),
        bytes.subarray(0, size),
      );
      const text = transcripts.get(basename);
      await Deno.writeTextFile(
        path.join(directory, `speech-${language}.txt`),
        text,
      );
      manifest.push({
        id: `speech-${language}`,
        text,
        audio: output,
        source: "google/fleurs",
        config,
        sourceFilename: basename,
        license: "CC BY 4.0",
      });
      await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(JSON.stringify({ language, output, bytes: size, text }));
      break;
    }
  } finally {
    await reader.cancel();
  }
}
