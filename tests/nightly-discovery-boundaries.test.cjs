const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withState(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardog-discovery-'));
  const previous = { home: process.env.GUARDOG_HOME, depth: process.env.GUARDOG_MAX_DEPTH };
  process.env.GUARDOG_HOME = path.join(root, 'state');
  fs.mkdirSync(process.env.GUARDOG_HOME);
  fs.writeFileSync(path.join(process.env.GUARDOG_HOME, 'config.json'), JSON.stringify({ nightlyUpdates: false, scanRoots: [root] }));
  const ok = () => ({ status: 0, stdout: JSON.stringify({ status: 'complete', dependencyCount: 1, dangerousCount: 0, issues: [] }) });
  return fn(root, ok).finally(() => {
    if (previous.home === undefined) delete process.env.GUARDOG_HOME; else process.env.GUARDOG_HOME = previous.home;
    if (previous.depth === undefined) delete process.env.GUARDOG_MAX_DEPTH; else process.env.GUARDOG_MAX_DEPTH = previous.depth;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('Library directly under the home directory is skipped; a project Library folder elsewhere is not', () => withState(async (root, ok) => {
  const { runNightly } = await import('../bin/nightly-scan.js');
  fs.mkdirSync(path.join(root, 'Library', 'Caches', 'tool'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Library', 'Caches', 'tool', 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'project', 'Library'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project', 'Library', 'package.json'), '{}');
  const scanned = [];
  const run = (_, args) => { scanned.push(args[1]); return ok(); };
  const health = { platform: 'linux', run: () => ({ status: 0, stdout: '' }) };
  const receipt = runNightly({ roots: [root], run, homeDirectory: root, healthOptions: health });
  assert.ok(scanned.every((m) => !m.includes(path.join('Library', 'Caches'))), 'home Library must not be walked');
  assert.ok(scanned.some((m) => m.includes(path.join('project', 'Library'))), 'a Library folder inside a project still scans');
  assert.equal(receipt.status, 'complete');
}));

test('reaching the depth limit and unreadable folders are counted as boundaries, not failures', () => withState(async (root, ok) => {
  const { runNightly } = await import('../bin/nightly-scan.js');
  process.env.GUARDOG_MAX_DEPTH = '1';
  fs.mkdirSync(path.join(root, 'shallow'));
  fs.writeFileSync(path.join(root, 'shallow', 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'package.json'), '{}');
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  const health = { platform: 'linux', run: () => ({ status: 0, stdout: '' }) };
  try {
    const receipt = runNightly({ roots: [root], run: () => ok(), healthOptions: health });
    assert.ok(receipt.boundaries.depthLimited >= 1, 'depth boundary counted');
    assert.ok(receipt.issues.every((issue) => !/depth exceeded/i.test(issue)), 'depth limit is not an issue');
    if (process.getuid && process.getuid() !== 0) {
      assert.ok(receipt.boundaries.unreadable >= 1, 'unreadable folder counted');
      assert.ok(receipt.issues.every((issue) => !issue.startsWith('Cannot read')), 'unreadable folder below the root is not an issue');
    }
    assert.equal(receipt.status, 'complete');
    assert.ok(receipt.boundaries.samples.length >= 1);
  } finally { fs.chmodSync(locked, 0o755); }
}));

test('an unreadable scan root is still reported as an issue', () => withState(async (root, ok) => {
  const { runNightly } = await import('../bin/nightly-scan.js');
  if (process.getuid && process.getuid() === 0) return;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'guardog-locked-root-'));
  fs.chmodSync(other, 0o000);
  fs.mkdirSync(path.join(root, 'p')); fs.writeFileSync(path.join(root, 'p', 'package.json'), '{}');
  const health = { platform: 'linux', run: () => ({ status: 0, stdout: '' }) };
  try {
    const receipt = runNightly({ roots: [root, other], run: () => ok(), healthOptions: health });
    assert.ok(receipt.issues.some((issue) => issue.startsWith('Cannot read ' + other)));
    assert.equal(receipt.status, 'incomplete');
  } finally { fs.chmodSync(other, 0o755); fs.rmSync(other, { recursive: true, force: true }); }
}));
