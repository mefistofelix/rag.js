// Optional portable Windows CUDA runtime. No Python or system SDK installation.
import * as path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve("tools/ort-gpu");
const assets = [
  {
    name: "onnxruntime-win-x64-gpu-1.24.1.zip",
    url:
      "https://github.com/microsoft/onnxruntime/releases/download/v1.24.1/onnxruntime-win-x64-gpu-1.24.1.zip",
    sha256: "176af2aade9eb9e429cd2a738aa5d71a1f20ec7123e4b99a382ad62b9db970fb",
  },
  {
    name: "nvidia_cuda_runtime_cu12-12.9.79-py3-none-win_amd64.whl",
    url:
      "https://files.pythonhosted.org/packages/59/df/e7c3a360be4f7b93cee39271b792669baeb3846c58a4df6dfcf187a7ffab/nvidia_cuda_runtime_cu12-12.9.79-py3-none-win_amd64.whl",
    sha256: "8e018af8fa02363876860388bd10ccb89eb9ab8fb0aa749aaf58430a9f7c4891",
  },
  {
    name: "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl",
    url:
      "https://files.pythonhosted.org/packages/20/e2/fc9a0e985249d873150276d5afb02e39a66817fedbf1a385724393e505ed/nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl",
    sha256: "623f43027d40d44ceadf0043f002bd25cf353e8f13ce90b9a87057019f560661",
  },
  {
    name: "nvidia_cudnn_cu12-9.27.0.42-py3-none-win_amd64.whl",
    url:
      "https://files.pythonhosted.org/packages/aa/38/f856579877f7c1c5066e61182e7de7bc27bf35a78c8d1b0fa592e6985bc4/nvidia_cudnn_cu12-9.27.0.42-py3-none-win_amd64.whl",
    sha256: "06e9b0026f3bad97d2b58666330fabec04fe1672f776661ecb0ce0029c27f142",
  },
];

async function digest(filename) {
  const hash = createHash("sha256");
  const file = await Deno.open(filename);
  for await (const bytes of file.readable) hash.update(bytes);
  return hash.digest("hex");
}

async function setupAsset(asset) {
  const archive = path.join(root, asset.name);
  try {
    await Deno.stat(archive);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    console.log(`Downloading ${asset.name}`);
    const download = await new Deno.Command("curl.exe", {
      args: ["-fLsS", "--retry", "2", asset.url, "-o", archive + ".part"],
    }).output();
    if (!download.success) {
      throw new Error(new TextDecoder().decode(download.stderr));
    }
    await Deno.rename(archive + ".part", archive);
  }
  if (await digest(archive) !== asset.sha256) {
    throw new Error(`SHA-256 mismatch: ${asset.name}`);
  }
  const destination = path.join(root, asset.name.replace(/\.(zip|whl)$/, ""));
  const marker = path.join(destination, ".complete");
  try {
    await Deno.stat(marker);
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const extract = await new Deno.Command("powershell.exe", {
    args: [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
      `[IO.Compression.ZipFile]::ExtractToDirectory(${quote(archive)}, ${
        quote(destination)
      })`,
    ],
  }).output();
  if (!extract.success) {
    throw new Error(new TextDecoder().decode(extract.stderr));
  }
  await Deno.writeTextFile(marker, asset.sha256);
  console.log(`Verified and extracted ${asset.name}`);
}

export function gpuEnvironment() {
  const directories = [
    path.join(
      root,
      "onnxruntime-win-x64-gpu-1.24.1",
      "onnxruntime-win-x64-gpu-1.24.1",
      "lib",
    ),
    path.join(
      root,
      "nvidia_cuda_runtime_cu12-12.9.79-py3-none-win_amd64",
      "nvidia",
      "cuda_runtime",
      "bin",
    ),
    path.join(
      root,
      "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64",
      "nvidia",
      "cublas",
      "bin",
    ),
    path.join(
      root,
      "nvidia_cudnn_cu12-9.27.0.42-py3-none-win_amd64",
      "nvidia",
      "cudnn",
      "bin",
    ),
  ];
  return {
    ORT_DYLIB_PATH: path.join(directories[0], "onnxruntime.dll"),
    PATH: [...directories, Deno.env.get("PATH") ?? ""].join(path.delimiter),
  };
}

if (import.meta.main) {
  if (Deno.build.os !== "windows" || Deno.build.arch !== "x86_64") {
    throw new Error("This optional portable runtime setup targets Windows x64");
  }
  await Deno.mkdir(root, { recursive: true });
  // Independent downloads; each archive has its own extraction directory.
  const results = await Promise.allSettled(assets.map(setupAsset));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  await Deno.stat(gpuEnvironment().ORT_DYLIB_PATH);
  console.log("Portable ONNX Runtime CUDA setup complete.");
}
