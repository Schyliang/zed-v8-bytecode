// SPDX-License-Identifier: GPL-3.0-only
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const snapshot = path.join(root, '.build', 'grammar-repository');
const devExtension = path.join(root, '.build', 'dev-extension');

function git(args) {
  const result = spawnSync('rtk', ['git', ...args], {
    cwd: snapshot, encoding: 'utf8',
    // Keep the generated artifact reproducible and separate from user identity.
    env: { ...process.env, GIT_AUTHOR_NAME: 'Local Grammar Build',
      GIT_AUTHOR_EMAIL: 'grammar-build@localhost', GIT_COMMITTER_NAME: 'Local Grammar Build',
      GIT_COMMITTER_EMAIL: 'grammar-build@localhost',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git exited ${result.status}`);
  return result.stdout.trim();
}

try {
  await mkdir(snapshot, { recursive: true });
  await cp(path.join(root, 'tree-sitter-ignition', 'src'), path.join(snapshot, 'src'), { recursive: true });
  await cp(path.join(root, 'tree-sitter-ignition', 'grammar.js'), path.join(snapshot, 'grammar.js'));
  await cp(path.join(root, 'LICENSE'), path.join(snapshot, 'LICENSE'));
  await cp(path.join(root, 'NOTICE.md'), path.join(snapshot, 'NOTICE.md'));
  await cp(path.join(root, 'licenses'), path.join(snapshot, 'licenses'), { recursive: true });
  git(['init', '--quiet']);
  git(['-c', 'core.autocrlf=false', 'add', 'src', 'grammar.js', 'LICENSE', 'NOTICE.md', 'licenses']);
  const tree = git(['write-tree']);
  // commit-tree creates only a build snapshot; no source project is committed.
  const revision = git(['commit-tree', tree, '-m', 'build: snapshot ignition grammar']);
  git(['update-ref', 'refs/heads/main', revision]);
  const template = await readFile(path.join(root, 'extension.template.toml'), 'utf8');
  const manifest = template.replace('{{GRAMMAR_REPOSITORY}}', pathToFileURL(snapshot).href)
    .replace('{{GRAMMAR_REVISION}}', revision);
  await mkdir(devExtension, { recursive: true });
  await cp(path.join(root, 'languages'), path.join(devExtension, 'languages'), { recursive: true });
  await cp(path.join(root, 'LICENSE'), path.join(devExtension, 'LICENSE'));
  await cp(path.join(root, 'NOTICE.md'), path.join(devExtension, 'NOTICE.md'));
  await cp(path.join(root, 'licenses'), path.join(devExtension, 'licenses'), { recursive: true });
  await writeFile(path.join(devExtension, 'extension.toml'), manifest);
  console.log('Prepared .build/dev-extension with a local grammar snapshot.');
  console.log(`In Zed: Extensions → Install Dev Extension → ${devExtension}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
