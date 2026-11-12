#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const defaultRuntimeRoot = process.env.DSH_TEST_RUNTIME_ROOT ?? [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/resources/dsh-app'),
  path.join(homedir(), 'AppData/Local/Programs/DeepSeek Harness/resources/dsh-app'),
].find((candidate) => candidate && existsSync(path.join(candidate, 'node_modules/@deepseek-ai/dsh/package.json')));
export const defaultNpmCli = process.env.DSH_TEST_NPM_CLI
  ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

// Inherited by the existing DSH CLI, the existing pnpm, and the loader probe.
// This is an additional process-local guard; --offline is also passed to pnpm.
const denyNetwork = `
const fs = require('node:fs');
const denied = () => {
  fs.appendFileSync(process.env.DSH_INSTALL_NETWORK_LOG, 'blocked\\n');
  throw Object.assign(new Error('Network prohibited in installation verification'), { code: 'INSTALL_NETWORK_BLOCKED' });
};
require('node:net').Socket.prototype.connect = denied;
require('node:net').connect = require('node:net').createConnection = denied;
require('node:tls').connect = denied;
for (const name of ['node:http', 'node:https']) {
  require(name).request = require(name).get = denied;
}
for (const name of ['node:dgram']) require(name).createSocket = denied;
for (const name of ['node:dns', 'node:dns/promises']) {
  const dns = require(name);
  for (const key of Object.keys(dns)) {
    if (/^(lookup|lookupService|resolve.*|reverse)$/.test(key)) dns[key] = denied;
  }
}
globalThis.fetch = denied;
require('node:module').syncBuiltinESMExports();
`;

function childEnvironment(paths) {
  // Deliberately exclude ambient credentials, proxy variables, NODE_OPTIONS,
  // npm/pnpm settings and the real DSH_HOME. No provider key is supplied.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|pathext|systemroot|windir|comspec)$/i.test(key)) env[key] = value;
  }
  return {
    ...env, DSH_HOME: paths.home, DSH_TELEMETRY_DISABLED: '1',
    HOME: paths.home, USERPROFILE: paths.home,
    APPDATA: paths.config, LOCALAPPDATA: paths.data,
    TEMP: paths.temp, TMP: paths.temp, CI: '1', NO_UPDATE_NOTIFIER: '1',
    XDG_CACHE_HOME: paths.cache, XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data, XDG_STATE_HOME: paths.state,
    npm_config_userconfig: paths.userconfig, npm_config_globalconfig: paths.globalconfig,
    npm_config_registry: 'http://127.0.0.1:9', npm_config_update_notifier: 'false',
    npm_config_ignore_scripts: 'true',
    NODE_DISABLE_COMPILE_CACHE: '1',
    NODE_OPTIONS: `--require ${JSON.stringify(paths.guard)}`,
    DSH_INSTALL_NETWORK_LOG: paths.networkLog,
  };
}

async function execute(label, args, { base, env, cwd = repoRoot }) {
  try {
    const result = await exec(process.execPath, args, { cwd, env, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(path.join(base, `${label}.stdout.log`), result.stdout);
    await writeFile(path.join(base, `${label}.stderr.log`), result.stderr);
    return result;
  } catch (error) {
    await writeFile(path.join(base, `${label}.stdout.log`), error.stdout ?? '');
    await writeFile(path.join(base, `${label}.stderr.log`), error.stderr ?? '');
    throw new Error(`${label} failed (${error.code ?? error.message}); see ${base}`, { cause: error });
  }
}

/** Probe public APIs of an explicitly selected, already-provisioned DSH runtime. */
export async function verifyInstallation({ runtimeRoot = defaultRuntimeRoot, expectedDshVersion, npmCli = defaultNpmCli, tarball, outputRoot = path.join(repoRoot, 'artifacts', 'installation-verification') } = {}) {
  if (!runtimeRoot) throw new Error('Existing DSH runtime not found; pass --runtime-root PATH or DSH_TEST_RUNTIME_ROOT');
  runtimeRoot = await realpath(runtimeRoot);
  const require = createRequire(path.join(runtimeRoot, 'package.json'));
  const dshManifestPath = require.resolve('@deepseek-ai/dsh/package.json');
  const runtimeModules = await realpath(path.join(runtimeRoot, 'node_modules'));
  const withinRuntime = (filename) => {
    const relative = path.relative(runtimeModules, filename);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'DSH must resolve inside the selected runtime');
  };
  withinRuntime(await realpath(dshManifestPath));
  const dshManifest = JSON.parse(await readFile(dshManifestPath, 'utf8'));
  assert.equal(dshManifest.name, '@deepseek-ai/dsh');
  assert.equal(typeof dshManifest.version, 'string', 'DSH must declare its version');
  if (expectedDshVersion !== undefined) assert.equal(dshManifest.version, expectedDshVersion, 'Selected runtime version differs from the requested version');
  const cli = path.join(path.dirname(dshManifestPath), dshManifest.bin.dsh);
  await access(cli);
  withinRuntime(await realpath(cli));
  const sourceManifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  await mkdir(outputRoot, { recursive: true });
  const base = await mkdtemp(path.join(await realpath(outputRoot), 'run-'));
  const paths = Object.fromEntries(['home', 'temp', 'cache', 'config', 'data', 'state', 'store', 'pack'].map((name) => [name, path.join(base, name)]));
  Object.assign(paths, {
    userconfig: path.join(base, 'empty-user.npmrc'), globalconfig: path.join(base, 'empty-global.npmrc'),
    guard: path.join(base, 'deny-network.cjs'), networkLog: path.join(base, 'network-attempts.log'),
  });
  await Promise.all(Object.values(paths).filter((value) => !path.extname(value)).map((dir) => mkdir(dir, { recursive: true })));
  await Promise.all([
    writeFile(paths.userconfig, ''), writeFile(paths.globalconfig, ''),
    writeFile(paths.guard, denyNetwork), writeFile(paths.networkLog, ''),
  ]);
  const env = childEnvironment(paths);
  // CLI environment loading must not inspect the checkout's optional .env file.
  const execution = { base, env, cwd: base };
  let packFiles;
  if (tarball === undefined) {
    npmCli = path.resolve(npmCli);
    await access(npmCli); // No corepack or other package-manager bootstrap.
    const packed = await execute('pack', [npmCli, 'pack', '--offline', '--ignore-scripts', '--json', '--cache', paths.cache, '--pack-destination', paths.pack, repoRoot], execution);
    const [manifest] = JSON.parse(packed.stdout);
    tarball = path.join(paths.pack, manifest.filename);
    packFiles = manifest.files.map(({ path: filename }) => filename);
  }
  tarball = await realpath(tarball);
  const profileName = 'incremental-install-smoke';
  // rc.6 forwards through cmd.exe; current DSH uses execa's argv handling.
  // Quotes embedded for rc.6 would become literal path characters on current DSH.
  const legacyWindowsShell = process.platform === 'win32' && dshManifest.version === '0.1.0-rc.6';
  if ([tarball, paths.store, paths.cache, paths.state].some((value) => /["%!\r\n]/u.test(value))) throw new Error('Installation path has unsupported shell characters');
  const packageManagerPath = (filename) => legacyWindowsShell ? `"${filename}"` : filename;
  const pnpmArgs = [
    'add', packageManagerPath(tarball), '--offline', '--ignore-scripts', '--reporter=append-only',
    '--config.auto-install-peers=false', '--config.update-notifier=false',
    '--config.manage-package-manager-versions=false', '--config.package-manager-strict=false',
    '--registry=http://127.0.0.1:9',
    `--store-dir=${packageManagerPath(paths.store)}`,
    `--cache-dir=${packageManagerPath(paths.cache)}`,
    `--config.state-dir=${packageManagerPath(paths.state)}`,
  ];
  await writeFile(path.join(base, 'command.json'), JSON.stringify({ node: process.execPath, runtimeRoot, dshVersion: dshManifest.version, cli, args: ['plugin', '--profile', profileName, ...pnpmArgs] }, null, 2));
  await execute('install', [cli, 'plugin', '--profile', profileName, ...pnpmArgs], execution);
  const profileDir = path.join(paths.home, 'profiles', profileName);
  const profile = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'));
  assert.ok(profile.dependencies['dsh-incremental']);
  assert.ok(profile.dsh.profile.bundles.includes('dsh-incremental'));
  const packageDir = path.join(profileDir, 'node_modules', 'dsh-incremental');
  assert.equal((await lstat(packageDir)).isSymbolicLink(), false, 'pnpm must materialize the tarball rather than link the checkout');
  assert.notEqual(await realpath(packageDir), await realpath(repoRoot));
  const installed = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  assert.equal(installed.name, 'dsh-incremental');
  assert.equal(typeof installed.version, 'string');
  if (packFiles) assert.equal(installed.version, sourceManifest.version);
  assert.equal(installed.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(typeof installed.icon, 'string', 'The installed package must declare its icon');
  const iconPath = await realpath(path.resolve(packageDir, installed.icon));
  const iconRelative = path.relative(await realpath(packageDir), iconPath);
  assert.ok(iconRelative && iconRelative !== '..' && !iconRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(iconRelative), 'The installed icon must remain inside its package');
  const profileRequire = createRequire(path.join(profileDir, 'package.json'));
  assert.equal(await realpath(profileRequire.resolve('dsh-incremental/icon')), iconPath);
  const iconBytes = await readFile(iconPath);
  assert.ok(iconBytes.length > 0);
  const modulesMetadata = await readFile(path.join(profileDir, 'node_modules', '.modules.yaml'), 'utf8');
  const packageManager = /["']?packageManager["']?:\s*["']?([^\s"',]+)/u.exec(modulesMetadata)?.[1];
  assert.match(packageManager ?? '', /^pnpm@/u);
  if (packFiles) for (const filename of packFiles) {
    assert.equal(sha256(await readFile(path.join(packageDir, filename))), sha256(await readFile(path.join(repoRoot, filename))), `Packed file differs: ${filename}`);
  }
  // This parses the complete default+plugin profile without booting it.
  const dump = await execute('dump-config', [cli, '--profile', profileName, '--dump-config'], execution);
  assert.match(dump.stdout, /name: dsh-incremental/);
  // Activate only the installed plugin row against public runtime tool services;
  // no desktop, session or model provider is booted.
  const loaderProbe = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { readFile, access, realpath } from 'node:fs/promises';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const runtimeRoot = ${JSON.stringify(runtimeRoot)};
    const profileDir = ${JSON.stringify(profileDir)};
    const home = ${JSON.stringify(paths.home)};
    const probeRoot = ${JSON.stringify(base)};
    const require = createRequire(path.join(runtimeRoot, 'package.json'));
    const fromRuntime = async (name) => {
      const entry = require.resolve(name);
      const resolved = await realpath(entry);
      const relative = path.relative(${JSON.stringify(runtimeModules)}, resolved);
      assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), name + ' resolved outside selected runtime');
      return import(pathToFileURL(entry).href);
    };
    const [{ Context }, { Loader }, boot, tools, system] = await Promise.all([
      fromRuntime('@deepseek-ai/cordis'), fromRuntime('@deepseek-ai/cordis-plugin-loader'),
      fromRuntime('@deepseek-ai/dsh-app-boot'), fromRuntime('@deepseek-ai/dsh-tools'), fromRuntime('@deepseek-ai/dsh-system-prompt'),
    ]);
    const defaultBundles = boot.DEFAULT_PROFILE_BUNDLES
      ?? (await fromRuntime('@deepseek-ai/dsh-official-bundles')).DEFAULT_PROFILE_BUNDLES;
    const loaded = boot.loadProfile('installation-smoke', ${JSON.stringify(profileName)}, path.join(runtimeRoot, 'package.json'), home);
    const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, [...defaultBundles, 'dsh-incremental']);
    const metadata = typeof boot.readPluginMeta === 'function'
      ? boot.readPluginMeta('dsh-incremental', pathToFileURL(profileDir).href + '/') : undefined;
    if (typeof boot.readPluginMeta === 'function') {
      assert.ok(metadata && !metadata.error, metadata?.error ?? 'Plugin metadata was not resolved');
      assert.equal(metadata.icon, 'data:image/svg+xml;base64,' + (await readFile(${JSON.stringify(iconPath)})).toString('base64'));
    }
    const layer = loaded.layers.find(({ packageName }) => packageName === 'dsh-incremental');
    assert.equal(layer.packageDir, ${JSON.stringify(packageDir)});
    const entries = boot.composeEntries([layer.patches, [{ id: 'incremental', config: {
      runtimeRoot, repoRoot: probeRoot, manifestPath: path.join(probeRoot, 'not-opened.json'),
      stateDir: path.join(probeRoot, 'not-created'), provider: 'deepseek-official', model: 'unused-offline-model',
      credentialEnv: 'UNSET_INSTALL_SMOKE_KEY', allowRemote: false,
      connection: { adapter: 'deepseek', baseURL: 'https://example.invalid' },
    } }]]);
    const root = new Context();
    try {
      await root.plugin(system.default);
      await root.plugin(tools.ToolRuntime);
      await root.plugin(Loader, { baseUrl: pathToFileURL(profileDir).href + '/' });
      for (const entry of entries) await root.loader.create(entry);
      await root.loader.await();
      const audit = boot.assertEntriesActivated ?? boot.auditStartupEntries;
      assert.equal(typeof audit, 'function', 'Runtime must expose a public startup audit');
      const activationWarnings = [];
      await audit(root, 'installation-smoke', (warning) => activationWarnings.push(warning));
      assert.deepEqual(activationWarnings, []);
      const registered = root.tools.schemas().map(({ name }) => name).sort();
      assert.deepEqual(registered, ['incremental_plan', 'incremental_report', 'incremental_run']);
      await root.loader.remove('incremental');
      assert.equal(root.tools.schemas().length, 0);
      await assert.rejects(access(path.join(probeRoot, 'not-created')), { code: 'ENOENT' });
      process.stdout.write(JSON.stringify({ registered, unloaded: true, profileLayers: loaded.layers.length, defaultBundles,
        iconMetadataReader: typeof boot.readPluginMeta === 'function' ? 'readPluginMeta' : 'unavailable', iconMetadataResolved: Boolean(metadata?.icon) }));
    } finally { await root.fiber.dispose(); }
  `;
  const activation = JSON.parse((await execute('activate', ['--input-type=module', '-e', loaderProbe], execution)).stdout);
  const networkAttempts = (await readFile(paths.networkLog, 'utf8')).trim().split('\n').filter(Boolean).length;
  assert.equal(networkAttempts, 0, 'Any attempted network use fails this probe');
  const result = {
    status: 'passed', nodeVersion: process.version, runtimeRoot, dshVersion: dshManifest.version, packageManager,
    tarball, tarballSha256: sha256(await readFile(tarball)), profileDir, packageDir,
    packageVersion: installed.version, bundles: profile.dsh.profile.bundles,
    icon: installed.icon, iconSha256: sha256(iconBytes), iconExportResolved: true,
    packedFilesCompared: packFiles?.length ?? null, lifecycleScripts: 'disabled',
    packageManagerMode: 'offline', providerCredentialsSupplied: false, networkAttempts,
    ...activation, evidenceDirectory: base,
  };
  await writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = { '--runtime-root': 'runtimeRoot', '--expected-dsh-version': 'expectedDshVersion', '--npm-cli': 'npmCli', '--tarball': 'tarball', '--output': 'outputRoot' }[process.argv[index]];
    if (!key || process.argv[index + 1] === undefined) throw new Error('Usage: node tools/verify-installation.mjs [--runtime-root PATH] [--expected-dsh-version VERSION] [--npm-cli PATH] [--tarball PATH] [--output PATH]');
    options[key] = key === 'expectedDshVersion' ? process.argv[index + 1] : path.resolve(process.argv[index + 1]);
  }
  console.log(JSON.stringify(await verifyInstallation(options), null, 2));
}
