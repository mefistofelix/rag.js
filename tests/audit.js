import * as path from "node:path";

const candidates = [
  {
    name: "whisper-cpp-node",
    version: "0.2.12",
    repo: "predict-woo/whisper.cpp",
  },
  {
    name: "@fugood/whisper.node",
    version: "1.1.3",
    repo: "mybigday/whisper.node",
  },
  { name: "node-av", version: "6.1.1", repo: "seydx/node-av" },
  { name: "sherpa-onnx-node", version: "1.13.8", repo: "k2-fsa/sherpa-onnx" },
  {
    name: "@napi-rs/whisper",
    version: "0.0.4",
    repo: "Brooooooklyn/whisper-node",
  },
  { name: "@xberg-io/xberg", version: "1.3.10", repo: "xberg-io/xberg" },
  {
    name: "@tursodatabase/database",
    version: "0.8.3",
    repo: "tursodatabase/turso",
  },
];

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return await response.json();
}

const results = await Promise.all(candidates.map(async (candidate) => {
  const output = { ...candidate };
  try {
    const npm = await json(
      `https://registry.npmjs.org/${encodeURIComponent(candidate.name)}`,
    );
    const metadata = npm.versions[candidate.version];
    output.published = npm.time[candidate.version];
    output.npmLatestTag = npm["dist-tags"].latest;
    output.repositoryInPackage = metadata.repository;
    output.optionalDependencies = metadata.optionalDependencies ?? {};
    output.packageIntegrity = metadata.dist.integrity;
    const dependencyPairs = Object.entries(output.optionalDependencies).filter((
      [name],
    ) =>
      /whisper|node-av|sherpa|xberg-(darwin|linux|win)|lancedb-(darwin|linux|win)|database-(darwin|linux|win)/
        .test(name)
    );
    output.nativePackages = await Promise.all(
      dependencyPairs.map(async ([name, range]) => {
        const version = range.replace(/^[~^]/, "");
        try {
          const asset = await json(
            `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
          );
          return {
            name,
            version,
            published: true,
            os: asset.os,
            cpu: asset.cpu,
            unpackedBytes: asset.dist.unpackedSize,
            integrity: asset.dist.integrity,
          };
        } catch (error) {
          return { name, version, published: false, error: String(error) };
        }
      }),
    );
  } catch (error) {
    output.npmError = String(error);
  }
  try {
    const repo = await json(`https://api.github.com/repos/${candidate.repo}`);
    output.github = {
      fullName: repo.full_name,
      archived: repo.archived,
      stars: repo.stargazers_count,
      pushedAt: repo.pushed_at,
      openIssuesAndPullRequests: repo.open_issues_count,
    };
  } catch (error) {
    output.githubError = String(error);
  }
  return output;
}));

await Deno.mkdir(path.resolve("build/results"), { recursive: true });
await Deno.writeTextFile(
  path.resolve("build/results/dependency-audit.json"),
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
);
for (const result of results) {
  console.log(JSON.stringify({
    name: result.name,
    version: result.version,
    published: result.published,
    github: result.github,
    nativePackages: result.nativePackages?.map((entry) => ({
      name: entry.name,
      published: entry.published,
    })),
  }));
}
