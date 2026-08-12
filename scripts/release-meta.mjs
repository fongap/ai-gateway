import { getArtifactBaseName, getRepositoryUrl, readPackageMeta } from './project-meta.mjs';

const pkg = readPackageMeta();
const values = {
  name: pkg.name,
  version: pkg.version,
  artifact: getArtifactBaseName(pkg),
  repository: getRepositoryUrl(pkg),
};

const key = process.argv[2];
if (key) {
  if (!(key in values)) throw new Error(`Unknown release metadata key: ${key}`);
  process.stdout.write(String(values[key]));
} else {
  process.stdout.write(JSON.stringify(values));
}
