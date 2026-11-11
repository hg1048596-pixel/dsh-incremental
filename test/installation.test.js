import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultRuntimeRoot, verifyInstallation } from '../tools/verify-installation.mjs';

const pnpmPresent = (process.env.PATH ?? '').split(path.delimiter).some((directory) =>
  existsSync(path.join(directory, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')));
const npmPresent = existsSync(path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'));
const unavailable = !defaultRuntimeRoot ? 'Existing DSH rc.6 runtime is absent'
  : !pnpmPresent ? 'Existing pnpm is absent' : !npmPresent ? 'Existing npm is absent' : false;

test('public DSH CLI installs a fresh local tarball offline and activates its installed bundle', { skip: unavailable, timeout: 180000 }, async (t) => {
  const temporaryRoot = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temporaryRoot, 'incremental-install-'));
  t.after(async () => {
    // Check the absolute deletion target; fs.rm removes junctions themselves.
    assert.equal(path.dirname(await realpath(base)), temporaryRoot);
    await rm(base, { recursive: true, force: true });
  });
  const result = await verifyInstallation({ outputRoot: base });
  assert.equal(result.status, 'passed');
  assert.equal(result.packageVersion, '0.1.0');
  assert.match(result.packageManager, /^pnpm@/u);
  assert.ok(result.packedFilesCompared > 0);
  assert.equal(result.networkAttempts, 0);
  assert.equal(result.providerCredentialsSupplied, false);
  assert.deepEqual(result.registered, ['incremental_plan', 'incremental_report', 'incremental_run']);
  assert.equal(result.unloaded, true);
  const installed = JSON.parse(await readFile(path.join(result.packageDir, 'package.json'), 'utf8'));
  assert.equal(installed.dsh.bundle.patch, './cordis.patch.yml');
});
