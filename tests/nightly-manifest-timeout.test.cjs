const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a manifest that times out is skipped with a logged issue and later manifests still scan', async () => {
  const { runNightly } = await import('../bin/nightly-scan.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardog-manifest-timeout-'));
  const previous = process.env.GUARDOG_HOME;
  process.env.GUARDOG_HOME = path.join(root, 'state');
  fs.mkdirSync(process.env.GUARDOG_HOME);
  fs.writeFileSync(path.join(process.env.GUARDOG_HOME, 'config.json'), JSON.stringify({ nightlyUpdates: false, scanRoots: [root] }));
  for (const name of ['a-slow', 'b-ok']) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'package.json'), '{}');
  }
  const calls = [];
  const scanner = (_, args, options) => {
    calls.push({ manifest: args[1], timeout: options.timeout });
    if (args[1].includes('a-slow')) {
      const error = new Error('spawnSync node ETIMEDOUT'); error.code = 'ETIMEDOUT';
      return { status: null, signal: 'SIGKILL', error, stdout: '' };
    }
    return { status: 0, stdout: JSON.stringify({ status: 'complete', dependencyCount: 3, dangerousCount: 0, issues: [] }) };
  };
  try {
    const receipt = runNightly({ roots: [root], run: scanner, manifestTimeoutMs: 1234, healthOptions: { platform: 'linux', run: () => ({ status: 0, stdout: '' }) } });
    assert.equal(calls.length, 2, 'the scan must continue past the timed-out manifest');
    for (const call of calls) assert.ok(call.timeout <= 1234, 'each manifest gets the per-manifest cap, not the whole budget');
    assert.equal(receipt.dependencyCount, 3);
    assert.ok(receipt.issues.some((issue) => /timed out after 1234ms and was skipped: .*a-slow/.test(issue)));
    assert.equal(receipt.status, 'incomplete');
  } finally {
    if (previous === undefined) delete process.env.GUARDOG_HOME; else process.env.GUARDOG_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
