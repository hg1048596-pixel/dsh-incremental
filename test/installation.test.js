import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { defaultNpmCli, defaultRuntimeRoot, findNpmCli, verifyInstallation } from '../tools/verify-installation.mjs';

const pnpmPresent = (process.env.PATH ?? '').split(path.delimiter).some((directory) =>
  existsSync(path.join(directory, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')));
const npmPresent = defaultNpmCli && existsSync(defaultNpmCli);
const unavailable = !defaultRuntimeRoot ? 'Selected DSH runtime is absent'
  : !pnpmPresent ? 'Existing pnpm is absent' : !npmPresent ? 'Existing npm is absent' : false;
const explicitRuntimeSelected = process.env.DSH_TEST_RUNTIME_ROOT !== undefined;

test('public DSH CLI installs a fresh local tarball offline and activates its installed bundle', { skip: !explicitRuntimeSelected && unavailable, timeout: 180000 }, async (t) => {
  assert.equal(unavailable, false, `Selected DSH runtime cannot be verified: ${unavailable}`);
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

test('npm CLI discovery supports npm scripts and standalone Windows and Unix Node layouts', async (t) => {
  const temporaryRoot = await realpath(tmpdir());
  const base = await mkdtemp(path.join(temporaryRoot, 'incremental-npm-discovery-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(base)), temporaryRoot);
    await rm(base, { recursive: true, force: true });
  });
  const windowsNode = path.join(base, 'windows', 'node.exe');
  const unixNode = path.join(base, 'unix', 'bin', 'node');
  const windowsNpm = path.join(base, 'windows', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const unixNpm = path.join(base, 'unix', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const scriptNpm = path.join(base, 'npm-script', 'npm-cli.js');
  for (const filename of [windowsNpm, unixNpm, scriptNpm]) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, '// npm CLI location fixture\n');
  }
  assert.equal(findNpmCli({ env: {}, execPath: windowsNode }), windowsNpm);
  assert.equal(findNpmCli({ env: {}, execPath: unixNode }), unixNpm);
  assert.equal(findNpmCli({ env: { npm_execpath: scriptNpm }, execPath: unixNode }), scriptNpm);
  assert.equal(findNpmCli({ env: { npm_execpath: path.relative(process.cwd(), scriptNpm) }, execPath: unixNode }), unixNpm);
  assert.equal(findNpmCli({ env: { DSH_TEST_NPM_CLI: path.join(base, 'missing-npm.js'), npm_execpath: scriptNpm }, execPath: unixNode }), path.join(base, 'missing-npm.js'));
});

test('an explicitly selected integration runtime fails when its installation prerequisites are absent', async () => {
  const testFile = fileURLToPath(import.meta.url);
  const env = { ...process.env, PATH: '', Path: '', DSH_TEST_RUNTIME_ROOT: path.join(tmpdir(), 'explicit-installation-runtime'), DSH_TEST_NPM_CLI: path.join(tmpdir(), 'absent-npm-cli.js') };
  // Start a separate runner rather than inheriting this test worker's IPC mode.
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--test', '--test-name-pattern=^public DSH CLI installs', testFile,
  ], {
    env,
    windowsHide: true, timeout: 30000,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /Selected DSH runtime cannot be verified: Existing pnpm is absent/);
    assert.doesNotMatch(error.stdout, /SKIP Existing pnpm is absent/);
    return true;
  });
});
