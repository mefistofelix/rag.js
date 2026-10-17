import * as path from "node:path";
import { glob } from "node:fs/promises";
import { globToRegExp } from "jsr:@std/path@1.1.6/posix/glob-to-regexp";

const examples = [
  ["docs/a.pdf", "docs/**/*.pdf"],
  ["docs/sub/a.pdf", "docs/**/*.pdf"],
  ["docs/a.txt", "docs/**/*.pdf"],
  ["a.md", "**/*.{md,txt}"],
  [".hidden/a.md", "**/*.md"],
  ["docs/sub/a.pdf", "docs/*.pdf"],
];
const output = {
  deno: Deno.version,
  target: Deno.build,
  standardLibrary: "jsr:@std/path@1.1.6/posix/glob-to-regexp",
  matching: examples.map(([filename, pattern]) => ({
    filename,
    pattern,
    builtin: path.posix.matchesGlob(filename, pattern),
    standard: globToRegExp(pattern, { globstar: true }).test(filename),
  })),
  builtinScan: [],
};
for await (const filename of glob("*.md", { cwd: import.meta.dirname })) {
  output.builtinScan.push(filename);
}
output.builtinScan.sort();
await Deno.mkdir("build/results", { recursive: true });
await Deno.writeTextFile(
  "build/results/glob-standard.json",
  JSON.stringify(output, null, 2),
);
console.log(JSON.stringify(output));
