#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(packageRoot, 'eval/m5/corpus.lock.json');
const localRoot = join(packageRoot, 'node_modules/.cache/m5-eval');
const verifyOnly = process.argv.includes('--verify-only');

function fail(message) {
  throw new Error(message);
}

function loadLock() {
  if (!existsSync(lockPath)) fail(`missing corpus lock: ${lockPath}`);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const repository = lock.repository;
  if (!/^[0-9a-f]{40}$/.test(repository?.commit ?? '')) {
    fail('corpus lock must contain a complete 40-character lowercase commit');
  }
  if (!/^[0-9a-f]{64}$/.test(repository?.archiveSha256 ?? '')) {
    fail('corpus lock must contain a SHA-256 archive checksum');
  }
  if (!/^[0-9a-f]{64}$/.test(repository?.licenseSha256 ?? '')) {
    fail('corpus lock must contain a SHA-256 license checksum');
  }
  if (repository.archiveUrl !== `https://codeload.github.com/colinhacks/zod/tar.gz/${repository.commit}`) {
    fail('archive URL must be codeload URL for the locked commit');
  }
  if (lock.corpus?.scanRoot !== 'packages/zod/src') fail('unexpected corpus scan root');
  if (lock.corpus?.archiveRoot !== `zod-${repository.commit}`) fail('archive root does not match commit');
  return lock;
}

function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function assertFileSha(filePath, expected, label) {
  if (!existsSync(filePath)) fail(`${label} is missing: ${filePath}`);
  const actual = sha256(filePath);
  if (actual !== expected) fail(`${label} checksum mismatch: expected ${expected}, got ${actual}`);
}

function download(url, output) {
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.download-${process.pid}`;
  rmSync(temporary, { force: true });
  const commands = [
    ['wget', ['--no-verbose', '--output-document', temporary, url]],
    ['curl', ['--fail', '--location', '--silent', '--show-error', '--output', temporary, url]],
  ];
  let lastError = '';
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 });
    if (result.status === 0 && existsSync(temporary)) {
      renameSync(temporary, output);
      return;
    }
    lastError = `${command}: ${result.stderr?.trim() || `exit ${result.status}`}`;
    rmSync(temporary, { force: true });
  }
  fail(`unable to download locked archive from ${url}; ${lastError}`);
}

function archiveMembers(archive) {
  let listing;
  try {
    listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  } catch (error) {
    fail(`cannot read archive member list: ${error.message}`);
  }
  const members = listing.split('\n').filter(Boolean);
  if (members.length === 0) fail('archive contains no members');
  return members;
}

function validateMembers(members, expectedRoot) {
  const prefix = `${expectedRoot}/`;
  for (const member of members) {
    if (member.startsWith('/') || member.includes('\\')) fail(`unsafe archive member: ${member}`);
    const normalized = member.replace(/\/+/g, '/');
    if (normalized !== member || normalized.split('/').includes('..')) fail(`unsafe archive member: ${member}`);
    if (normalized !== expectedRoot && !normalized.startsWith(prefix)) {
      fail(`archive member escapes expected root ${expectedRoot}: ${member}`);
    }
  }
}

function ensureArchive(lock) {
  const archive = join(localRoot, 'downloads', lock.repository.archiveFile);
  if (!existsSync(archive)) {
    if (verifyOnly) fail(`offline verification cannot find archive: ${archive}`);
    console.log(`Downloading ${lock.repository.archiveUrl}`);
    download(lock.repository.archiveUrl, archive);
  }
  assertFileSha(archive, lock.repository.archiveSha256, 'archive');
  const size = lstatSync(archive).size;
  if (lock.repository.archiveBytes !== size) {
    fail(`archive byte size mismatch: expected ${lock.repository.archiveBytes}, got ${size}`);
  }
  const members = archiveMembers(archive);
  validateMembers(members, lock.corpus.archiveRoot);
  return { archive, members };
}

function ensureLicense(lock, archive, verifyOnlyMode) {
  const license = join(localRoot, 'licenses', 'zod-v4.4.3-LICENSE');
  mkdirSync(dirname(license), { recursive: true });
  if (!existsSync(license)) {
    if (verifyOnlyMode) fail(`offline verification cannot repair missing license: ${license}`);
    const member = `${lock.corpus.archiveRoot}/${lock.repository.licensePath}`;
    let contents;
    try {
      contents = execFileSync('tar', ['-xOf', archive, member]);
    } catch (error) {
      fail(`archive license is missing: ${member} (${error.message})`);
    }
    const hash = createHash('sha256').update(contents).digest('hex');
    if (hash !== lock.repository.licenseSha256) fail(`archive license checksum mismatch: expected ${lock.repository.licenseSha256}, got ${hash}`);
    writeFileSync(license, contents);
  }
  assertFileSha(license, lock.repository.licenseSha256, 'license');
  return license;
}

function walkFiles(root) {
  const files = [];
  const excluded = new Set(lockExcludes);
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (excluded.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const rel = relative(root, absolute).split(sep).join('/');
        files.push({ path: rel, bytes: lstatSync(absolute).size, sha256: sha256(absolute) });
      } else {
        fail(`unsupported non-regular file in scan root: ${absolute}`);
      }
    }
  }
  visit(root);
  return files;
}

let lockExcludes = [];

function createManifest(lock, scanRoot) {
  if (!existsSync(scanRoot) || !lstatSync(scanRoot).isDirectory()) fail(`scan root is missing: ${scanRoot}`);
  lockExcludes = lock.corpus.filters.exclude;
  const files = walkFiles(scanRoot);
  return {
    schemaVersion: 1,
    commit: lock.repository.commit,
    scanRoot: lock.corpus.scanRoot,
    filters: lock.corpus.filters,
    manifestAlgorithm: lock.corpus.manifestAlgorithm,
    capacity: lock.corpus.capacity,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
  };
}

function compareManifest(expected, actual) {
  const expectedJson = JSON.stringify(expected);
  const actualJson = JSON.stringify(actual);
  if (expectedJson !== actualJson) {
    const expectedPaths = new Set(expected.files.map((file) => file.path));
    const actualPaths = new Set(actual.files.map((file) => file.path));
    const added = actual.files.filter((file) => !expectedPaths.has(file.path)).map((file) => file.path);
    const removed = expected.files.filter((file) => !actualPaths.has(file.path)).map((file) => file.path);
    const changed = actual.files
      .filter((file) => expectedPaths.has(file.path))
      .filter((file) => JSON.stringify(file) !== JSON.stringify(expected.files.find((candidate) => candidate.path === file.path)))
      .map((file) => file.path);
    fail(`corpus manifest mismatch (added=${added.length}, removed=${removed.length}, changed=${changed.length})`);
  }
}

function prepareCorpus(lock, archive, members) {
  const corpusParent = join(localRoot, 'corpus');
  const corpusRoot = join(corpusParent, lock.corpus.archiveRoot);
  mkdirSync(corpusParent, { recursive: true });
  if (existsSync(corpusRoot)) {
    const markerPath = join(corpusRoot, '.m5-corpus-marker.json');
    if (!existsSync(markerPath)) fail(`refusing to use unmarked existing corpus: ${corpusRoot}`);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (marker.commit !== lock.repository.commit || marker.archiveSha256 !== lock.repository.archiveSha256) {
      fail(`corpus marker does not match lock: ${markerPath}`);
    }
    return corpusRoot;
  }
  const existing = readdirSync(corpusParent);
  if (existing.length > 0) fail(`refusing to extract into corpus directory with unknown entries: ${corpusParent}`);
  const temporaryRoot = join(corpusParent, `.extract-${process.pid}`);
  rmSync(temporaryRoot, { recursive: true, force: true });
  mkdirSync(temporaryRoot);
  try {
    execFileSync('tar', ['-xzf', archive, '-C', temporaryRoot], { stdio: 'pipe' });
    const extracted = join(temporaryRoot, lock.corpus.archiveRoot);
    if (!existsSync(extracted)) fail(`archive did not extract expected root: ${lock.corpus.archiveRoot}`);
    writeFileSync(join(extracted, '.m5-corpus-marker.json'), `${JSON.stringify({ schemaVersion: 1, commit: lock.repository.commit, archiveSha256: lock.repository.archiveSha256 }, null, 2)}\n`);
    renameSync(extracted, corpusRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return corpusRoot;
}

function existingCorpus(lock) {
  const corpusRoot = join(localRoot, 'corpus', lock.corpus.archiveRoot);
  const markerPath = join(corpusRoot, '.m5-corpus-marker.json');
  if (!existsSync(corpusRoot) || !existsSync(markerPath)) {
    fail(`offline verification cannot find prepared corpus marker: ${markerPath}`);
  }
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (marker.commit !== lock.repository.commit || marker.archiveSha256 !== lock.repository.archiveSha256) {
    fail(`corpus marker does not match lock: ${markerPath}`);
  }
  return corpusRoot;
}

function run() {
  const lock = loadLock();
  mkdirSync(localRoot, { recursive: true });
  const { archive, members } = ensureArchive(lock);
  const manifestPath = join(packageRoot, lock.corpus.manifestFile);
  const expectedCorpusRoot = join(localRoot, 'corpus', lock.corpus.archiveRoot);
  if (!verifyOnly && existsSync(expectedCorpusRoot) && !existsSync(manifestPath)) {
    fail(`refusing to create a first manifest for an existing corpus; remove the corpus and prepare again: ${expectedCorpusRoot}`);
  }
  const corpusRoot = verifyOnly ? existingCorpus(lock) : prepareCorpus(lock, archive, members);
  ensureLicense(lock, archive, verifyOnly);
  const scanRoot = join(corpusRoot, lock.corpus.scanRoot);
  const actualManifest = createManifest(lock, scanRoot);
  if (existsSync(manifestPath)) {
    const expectedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    compareManifest(expectedManifest, actualManifest);
  } else if (verifyOnly) {
    fail(`offline verification cannot find manifest: ${manifestPath}`);
  } else {
    writeFileSync(manifestPath, `${JSON.stringify(actualManifest, null, 2)}\n`);
  }
  console.log(`M5 corpus ${verifyOnly ? 'verified' : 'prepared'}: ${actualManifest.fileCount} files, ${actualManifest.totalBytes} bytes`);
  if (!verifyOnly) console.log(`scan root: ${scanRoot}`);
}

try {
  run();
} catch (error) {
  console.error(`M5 preparation failed: ${error.message}`);
  process.exitCode = 1;
}
