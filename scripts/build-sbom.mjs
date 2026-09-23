// Generates an SPDX 2.3 SBOM for what ships.
//
// What ships is the static site in dist/ plus the WASM modules in build/. Both
// contain code from the vendored upstreams, so the SBOM has to name those with
// the exact commit they were taken at, not a version range. vendor/sources.json
// already pins each one; this reads it rather than keeping a second list that
// could drift.
//
// npm dependencies are split: only `dependencies` end up in the bundle.
// devDependencies build it and are recorded separately, because a reader
// checking what they are running should not have to guess which is which.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'sbom.spdx.json');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const vendor = JSON.parse(readFileSync(join(root, 'vendor', 'sources.json'), 'utf8'));

function gitDescribe() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

function spdxId(kind, name) {
  return `SPDXRef-${kind}-${name.replace(/[^A-Za-z0-9.-]/g, '-')}`;
}

/** SPDX wants a license expression or NOASSERTION. Keep the recorded string. */
function license(value) {
  return typeof value === 'string' && value.length > 0 ? value : 'NOASSERTION';
}

const commit = gitDescribe();
const rootId = spdxId('Package', pkg.name);

const packages = [
  {
    SPDXID: rootId,
    name: pkg.name,
    versionInfo: `${pkg.version}+git.${commit.slice(0, 12)}`,
    downloadLocation: 'https://github.com/Khronos31/WebTS.app',
    filesAnalyzed: false,
    licenseConcluded: license(pkg.license),
    licenseDeclared: license(pkg.license),
    copyrightText: 'NOASSERTION',
    comment: 'The application itself. Ships as a static site plus WASM modules.',
  },
];

const relationships = [
  { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: rootId },
];

for (const source of vendor.sources) {
  const id = spdxId('Package', `vendor-${source.name}`);
  packages.push({
    SPDXID: id,
    name: source.name,
    versionInfo: source.ref === null ? source.commit : `${source.ref} (${source.commit})`,
    downloadLocation: source.origin,
    sourceInfo: `Vendored source, pinned at commit ${source.commit}. `
      + 'Only the files listed in vendor/sources.json are present.',
    filesAnalyzed: false,
    licenseConcluded: license(source.license),
    licenseDeclared: license(source.license),
    copyrightText: 'NOASSERTION',
    comment: source.purpose,
  });
  // 静的に取り込むので CONTAINS。実行時に取りに行く依存ではない。
  relationships.push({
    spdxElementId: rootId, relationshipType: 'CONTAINS', relatedSpdxElement: id,
  });
}

function npmPackages(names, kind, relationship) {
  for (const name of names) {
    let version = 'NOASSERTION';
    let declared = 'NOASSERTION';
    try {
      const meta = JSON.parse(
        readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
      version = meta.version ?? version;
      declared = license(meta.license);
    } catch {
      // 入っていなければ宣言だけ残す。嘘の版を書かない。
    }
    const id = spdxId('Package', `npm-${name}`);
    packages.push({
      SPDXID: id,
      name,
      versionInfo: version,
      downloadLocation: `https://registry.npmjs.org/${name}`,
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:npm/${name}@${version}`,
      }],
      filesAnalyzed: false,
      licenseConcluded: declared,
      licenseDeclared: declared,
      copyrightText: 'NOASSERTION',
      comment: kind,
    });
    relationships.push({
      spdxElementId: rootId, relationshipType: relationship, relatedSpdxElement: id,
    });
  }
}

npmPackages(Object.keys(pkg.dependencies ?? {}), 'Bundled into the shipped JavaScript.',
  'CONTAINS');
npmPackages(Object.keys(pkg.devDependencies ?? {}), 'Build and test only. Not shipped.',
  'BUILD_DEPENDENCY_OF');

const document = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `${pkg.name}-${pkg.version}`,
  documentNamespace: `https://webts.app/spdx/${pkg.version}/${commit}`,
  creationInfo: {
    // **時刻は固定しない。**生成物の内容はコミットで決まるので、日時が
    // 変わっても中身は変わらない。
    created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    creators: ['Tool: scripts/build-sbom.mjs'],
  },
  packages,
  relationships,
};

mkdirSync(dirname(output), { recursive: true });
const text = `${JSON.stringify(document, null, 2)}\n`;
writeFileSync(output, text);
const digest = createHash('sha256').update(text).digest('hex');
process.stdout.write(`wrote ${output}\n`);
process.stdout.write(`packages: ${packages.length}  sha256: ${digest}\n`);
