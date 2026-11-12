import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { snapshotTask, windowsPermissions } from '../src/snapshot.js';

const windowsOnly = { skip: process.platform !== 'win32', timeout: 90_000 };

// Keep the previous implementation as an independent compatibility reference.
// Paths are data on stdin, including names containing PowerShell syntax.
const legacyScript = String.raw`
$ErrorActionPreference = 'Stop'
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$entries = @()
$reasons = @()
$principal = $null
$identity = $null
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [ordered]@{ userSID = [string]$identity.User.Value; groupSIDs = @($identity.Groups | ForEach-Object { [string]$_.Value } | Sort-Object -Unique) }
  if ([string]::IsNullOrEmpty($principal.userSID)) { throw 'Current user SID is unavailable' }
} catch {
  $principal = $null
  $reasons += 'principal_unverifiable'
} finally {
  if ($null -ne $identity) { $identity.Dispose() }
}
foreach ($itemPath in $request.paths) {
  try {
    $item = Get-Item -LiteralPath $itemPath -Force
    $acl = Get-Acl -LiteralPath $itemPath
    $entries += [ordered]@{ path = [string]$itemPath; owner = [string]$acl.Owner; dacl = [string]$acl.Sddl; reparse = [bool](($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) }
  } catch {
    $entries += [ordered]@{ path = [string]$itemPath; error = [string]$_.Exception.GetType().FullName }
    $reasons += 'permission_unverifiable'
  }
}
[ordered]@{ verified = ($reasons.Count -eq 0); principal = $principal; entries = @($entries); reasons = @($reasons | Select-Object -Unique) } | ConvertTo-Json -Depth 8 -Compress
`;

const changeDaclScript = String.raw`
$ErrorActionPreference = 'Stop'
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$file = [IO.FileInfo]::new([string]$request.path)
$acl = [IO.FileSystemAclExtensions]::GetAccessControl($file)
if ($request.restore) {
  $acl.SetSecurityDescriptorSddlForm([string]$request.sddl, [Security.AccessControl.AccessControlSections]::Access)
} else {
  # Copy inherited rules when protecting the DACL, retaining current access.
  $acl.SetAccessRuleProtection((-not $acl.AreAccessRulesProtected), $true)
}
[IO.FileSystemAclExtensions]::SetAccessControl($file, $acl)
'{"ok":true}'
`;

function runPowerShell(script, request) {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1' },
    });
    const output = [], errors = [];
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', cause => { clearTimeout(timer); reject(cause); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`PowerShell fixture failed (${code}): ${Buffer.concat(errors).toString('utf8')}`));
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8').replace(/^\uFEFF/u, ''))); }
      catch (cause) { reject(cause); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'dsh-incremental-native-permissions-'));
  t.after(async () => {
    // Only recursively remove the exact, independently created temporary tree.
    assert.equal(path.dirname(directory).toLowerCase(), temporaryRoot.toLowerCase());
    assert(path.basename(directory).startsWith('dsh-incremental-native-permissions-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const repo = path.join(directory, 'repo');
  await fs.mkdir(repo);
  return { directory, repo };
}

function includingAncestors(paths) {
  const result = new Set();
  for (const itemPath of paths) {
    for (let current = itemPath; ; current = path.dirname(current)) {
      result.add(current);
      if (path.dirname(current) === current) break;
    }
  }
  return [...result].sort();
}

test('native Windows permission reads equal legacy metadata for files, directories and ancestors', windowsOnly, async t => {
  const { repo } = await fixture(t);
  const nested = path.join(repo, 'directory [literal]');
  await fs.mkdir(nested);
  const ordinary = path.join(nested, 'ordinary.txt');
  await fs.writeFile(ordinary, 'ordinary');
  const paths = includingAncestors([ordinary, nested]);
  const actual = await windowsPermissions(paths);
  const expected = await runPowerShell(legacyScript, { paths });
  assert.equal(expected.verified, true, JSON.stringify({ reasons: expected.reasons, errors: expected.entries.filter(entry => entry.error) }));
  assert.equal(actual.verified, true, JSON.stringify({ reasons: actual.reasons, errors: actual.entries.filter(entry => entry.error) }));
  assert.match(actual.principal.userSID, /^S-1-/u);
  assert.equal(actual.entries.length, paths.length);
  assert(actual.entries.every(entry => entry.owner && entry.dacl && entry.reparse === false));
  assert.deepEqual(actual, expected);
});

test('native Windows permission reads preserve Unicode filenames and literal shell characters', windowsOnly, async t => {
  const { repo } = await fixture(t);
  const ordinary = path.join(repo, 'ordinary.txt');
  const special = path.join(repo, "quoted' [literal] $name; café 中文.txt");
  await fs.writeFile(ordinary, 'ordinary');
  await fs.writeFile(special, 'literal');
  const actual = await windowsPermissions([special]);
  const expected = await runPowerShell(legacyScript, { paths: [ordinary] });
  assert.equal(expected.verified, true);
  assert.equal(actual.entries[0].path, special);
  assert.equal(actual.verified, true);
  assert.deepEqual(actual.principal, expected.principal);
  // Sibling files inherit the same owner and DACL. Use an ASCII legacy path so
  // this reference does not depend on the host's default console code page.
  assert.deepEqual(actual.entries, [{ ...expected.entries[0], path: special }]);
  assert.equal(await fs.readFile(special, 'utf8'), 'literal');
});

test('native Windows permission reads fail closed for a missing path without dropping other entries', windowsOnly, async t => {
  const { repo } = await fixture(t);
  const existing = path.join(repo, 'existing.txt'), missing = path.join(repo, 'missing.txt');
  await fs.writeFile(existing, 'existing');
  const result = await windowsPermissions([existing, missing]);
  assert.equal(result.verified, false);
  assert.deepEqual(result.reasons, ['permission_unverifiable']);
  assert.deepEqual(result.entries.map(entry => entry.path), [existing, missing]);
  assert.equal(typeof result.entries[0].dacl, 'string');
  assert.equal(typeof result.entries[1].error, 'string');
  assert.equal(result.entries[1].dacl, undefined);
});

test('native Windows inspection identifies an owned junction and snapshots reject it', windowsOnly, async t => {
  const { directory, repo } = await fixture(t);
  const target = path.join(directory, 'junction-target'), junction = path.join(repo, 'junction');
  await fs.mkdir(target);
  const marker = path.join(target, 'marker.txt');
  await fs.writeFile(marker, 'target remains');
  await fs.symlink(target, junction, 'junction');
  try {
    const result = await windowsPermissions([target, junction]);
    assert.equal(result.verified, true);
    assert.equal(result.entries.find(entry => entry.path === target).reparse, false);
    assert.equal(result.entries.find(entry => entry.path === junction).reparse, true);
    await assert.rejects(snapshotTask(repo, { files: [], directories: ['.'] }, {
      permissionProvider: paths => windowsPermissions(paths),
    }), { code: 'INPUT_LINK_FORBIDDEN' });
  } finally {
    // Unlink the junction itself before any recursive fixture cleanup.
    await fs.unlink(junction);
  }
  assert.equal(await fs.readFile(marker, 'utf8'), 'target remains');
});

test('native Windows snapshots detect real DACL changes and between-observation drift', windowsOnly, async t => {
  const { repo } = await fixture(t);
  const file = path.join(repo, 'owned-acl-fixture.txt');
  await fs.writeFile(file, 'same readable content');
  // Windows can add the auto-inherited DACL flag on the first ACL write.
  // Round-trip only this disposable file before capturing the exact baseline.
  const fresh = await windowsPermissions([file]);
  assert.equal(fresh.verified, true);
  await runPowerShell(changeDaclScript, { path: file, restore: true, sddl: fresh.entries[0].dacl });
  const inputs = { files: ['owned-acl-fixture.txt'], directories: [] };
  const options = { permissionProvider: paths => windowsPermissions(paths) };
  const initial = await snapshotTask(repo, inputs, options);
  assert.equal(initial.assurance.verified, true);
  const originalSddl = initial.permissions.entries.find(entry => entry.path === file).dacl;
  const restore = () => runPowerShell(changeDaclScript, { path: file, restore: true, sddl: originalSddl });
  try {
    await runPowerShell(changeDaclScript, { path: file, restore: false });
    assert.equal(await fs.readFile(file, 'utf8'), 'same readable content');
    const changed = await snapshotTask(repo, inputs, options);
    assert.equal(changed.assurance.verified, true);
    assert.deepEqual(changed.files, initial.files);
    assert.deepEqual(changed.permissions.principal, initial.permissions.principal);
    assert.notEqual(changed.permissions.entries.find(entry => entry.path === file).dacl, originalSddl);
    assert.notEqual(changed.digest, initial.digest);
  } finally {
    await restore();
  }
  assert.equal((await windowsPermissions([file])).entries[0].dacl, originalSddl);

  let observations = 0;
  try {
    await assert.rejects(snapshotTask(repo, inputs, {
      permissionProvider: async paths => {
        const result = await windowsPermissions(paths);
        if (++observations === 1) await runPowerShell(changeDaclScript, { path: file, restore: false });
        return result;
      },
    }), { code: 'SNAPSHOT_DRIFT' });
    assert.equal(observations, 2);
  } finally {
    await restore();
  }
  assert.equal((await windowsPermissions([file])).entries[0].dacl, originalSddl);
  assert.equal(await fs.readFile(file, 'utf8'), 'same readable content');
});
