// Shared test I/O; the product has no runtime shim.
import fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

export { fs };
export const name = globalThis.Bun ? "bun" : "deno";
export const args = process.argv.slice(2);
export const runtime = globalThis.Deno?.version ?? { bun: Bun.version };
export const platform = globalThis.Deno?.build ?? {
  os: process.platform,
  arch: process.arch,
};
export const readTextFile = (filename) => fs.readFile(filename, "utf8");
export const temporaryDirectory = ({ dir, prefix = "" }) =>
  fs.mkdtemp(path.join(dir, prefix));

const execute = promisify(execFile);
export async function command(executable, { args }) {
  try {
    const result = await execute(executable, args, {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ...result, success: true };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { stdout: error.stdout, stderr: error.stderr, success: false };
  }
}
