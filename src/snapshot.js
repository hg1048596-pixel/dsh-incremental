import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

function canonical(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export function stableDigest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? error('ABORT_ERR', 'Snapshot aborted');
}

function normalized(input, allowRoot) {
  if (typeof input !== 'string' || !input || /[\x00-\x1f:]/u.test(input)) {
    throw error('INPUT_PATH_INVALID', 'Input paths must be relative strings without control characters or alternate data streams');
  }
  const portable = input.replaceAll('\\', '/');
  if (portable.startsWith('/') || path.isAbsolute(input)) throw error('INPUT_PATH_INVALID', `Absolute input path: ${input}`);
  const parts = portable.split('/');
  if (parts.includes('..')) throw error('INPUT_PATH_INVALID', `Parent traversal is forbidden: ${input}`);
  const result = parts.filter(part => part && part !== '.').join('/');
  if (!result && !allowRoot) throw error('INPUT_PATH_INVALID', 'A file input cannot name the repository root');
  if (process.platform === 'win32' && parts.some(part => part && part !== '.' &&
      (/[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))) {
    throw error('INPUT_PATH_INVALID', `Ambiguous Windows input path: ${input}`);
  }
  return result || '.';
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function ancestors(target) {
  const result = [];
  for (let current = target; ; current = path.dirname(current)) {
    result.push(current);
    if (path.dirname(current) === current) return result;
  }
}

async function assertNoLinks(target, { canonicalize = false } = {}) {
  for (const candidate of ancestors(target).reverse()) {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) throw error('INPUT_LINK_FORBIDDEN', `Linked input or ancestor: ${candidate}`);
  }
  const real = await fs.realpath(target);
  if (!canonicalize && !samePath(real, target)) throw error('INPUT_LINK_FORBIDDEN', `Redirected input or ancestor: ${target}`);
  return real;
}

function statToken(stat) {
  return {
    dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), size: String(stat.size),
    mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
  };
}

// This script is constant. All filesystem names arrive as JSON over stdin.
const windowsPermissionScript = String.raw`
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

async function windowsPermissions(paths, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsPermissionScript], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal,
      env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1' },
    });
    const output = [];
    let length = 0;
    let tooLarge = false;
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) { tooLarge = true; child.kill(); }
      else output.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', cause => { clearTimeout(timeout); reject(cause); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 || tooLarge) reject(error('PERMISSION_UNVERIFIABLE', 'Windows permission inspection failed'));
      else {
        try { resolve(JSON.parse(Buffer.concat(output).toString('utf8').replace(/^\uFEFF/u, ''))); }
        catch (cause) { reject(cause); }
      }
    });
    child.stdin.end(JSON.stringify({ paths }));
  });
}

async function defaultPermissions(paths, signal) {
  if (process.platform === 'win32') return windowsPermissions(paths, signal);
  const entries = await Promise.all(paths.map(async itemPath => {
    const stat = await fs.lstat(itemPath);
    return { path: itemPath, owner: stat.uid, group: stat.gid, mode: stat.mode & 0o7777 };
  }));
  // uid/gid/mode do not attest extended POSIX ACLs or effective access.
  return { verified: false, entries, reasons: ['posix_acl_unverified'] };
}

async function permissionsFor(paths, provider, signal) {
  checkAbort(signal);
  try {
    const result = await (provider ? provider(paths) : defaultPermissions(paths, signal));
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.entries)) {
      return { verified: false, entries: [], reasons: ['permission_provider_invalid'] };
    }
    if (result.entries.some(entry => entry?.reparse === true)) throw error('INPUT_LINK_FORBIDDEN', 'Reparse point in input or ancestor');
    // A provider must attest every requested path, including repository ancestors.
    const entriesInvalid = result.entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.path !== 'string' || !entry.path || entry.error !== undefined);
    const covered = new Set(result.entries.map(entry => entry?.path));
    const complete = paths.every(itemPath => covered.has(itemPath));
    let principal = null;
    const principalInvalid = result.principal !== undefined && result.principal !== null &&
      (typeof result.principal.userSID !== 'string' || !result.principal.userSID ||
       !Array.isArray(result.principal.groupSIDs) || result.principal.groupSIDs.some(sid => typeof sid !== 'string' || !sid));
    if (result.principal && !principalInvalid) principal = {
      userSID: result.principal.userSID,
      groupSIDs: [...new Set(result.principal.groupSIDs)].sort(),
    };
    const reasonsInvalid = result.reasons !== undefined && (!Array.isArray(result.reasons) || result.reasons.some(reason => typeof reason !== 'string'));
    const providerReasons = Array.isArray(result.reasons) ? result.reasons.filter(reason => typeof reason === 'string') : [];
    const verified = result.verified === true && complete && !entriesInvalid && !reasonsInvalid && !principalInvalid && providerReasons.length === 0;
    const reasons = [...new Set([
      ...providerReasons,
      ...(!complete ? ['permission_metadata_incomplete'] : []),
      ...(entriesInvalid || reasonsInvalid ? ['permission_provider_invalid'] : []),
      ...(principalInvalid ? ['principal_unverifiable'] : []),
      ...(!verified && complete ? ['permission_unverifiable'] : []),
    ])].sort();
    const entries = [...result.entries].sort((a, b) => String(a.path).localeCompare(String(b.path), 'en'));
    // Reject non-serializable provider output before it can enter a cache key.
    return JSON.parse(JSON.stringify({ verified, principal, entries, reasons }));
  } catch (cause) {
    checkAbort(signal);
    if (cause.code === 'INPUT_LINK_FORBIDDEN') throw cause;
    return { verified: false, entries: [], reasons: ['permission_unverifiable'] };
  }
}

export async function snapshotTask(repoRoot, inputs, { maxBytes = 262144, signal, permissionProvider } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw error('INPUT_LIMIT_INVALID', 'maxBytes must be a nonnegative safe integer');
  if (!inputs || !Array.isArray(inputs.files) || !Array.isArray(inputs.directories)) throw error('INPUT_PATH_INVALID', 'Input files and directories must be arrays');
  const root = await assertNoLinks(path.resolve(repoRoot), { canonicalize: true });
  const rootStat = await fs.lstat(root, { bigint: true });
  if (!rootStat.isDirectory()) throw error('INPUT_PATH_INVALID', 'Repository root is not a directory');
  const repoIdentity = { path: root, device: String(rootStat.dev), inode: String(rootStat.ino) };
  const requestedFiles = [...new Set(inputs.files.map(item => normalized(item, false)))].sort();
  const requestedDirs = [...new Set(inputs.directories.map(item => normalized(item, true)))].sort();

  async function scan() {
    const files = new Map();
    const directories = new Map();
    const tokens = new Map();
    const permissionPaths = new Set(ancestors(root));
    let byteCount = 0;
    async function visit(relative, expected) {
      checkAbort(signal);
      const absolute = relative === '.' ? root : path.resolve(root, ...relative.split('/'));
      if (!within(root, absolute)) throw error('INPUT_PATH_INVALID', `Input escapes repository: ${relative}`);
      await assertNoLinks(absolute);
      for (const parent of ancestors(absolute)) permissionPaths.add(parent);
      const stat = await fs.lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw error('INPUT_LINK_FORBIDDEN', `Linked input: ${relative}`);
      const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      if (expected && expected !== type) throw error('INPUT_TYPE_INVALID', `Expected ${expected}: ${relative}`);
      if (type === 'other') throw error('INPUT_TYPE_INVALID', `Unsupported filesystem entry: ${relative}`);
      tokens.set(relative, statToken(stat));
      if (type === 'file') {
        if (files.has(relative)) return type;
        if (stat.size > BigInt(maxBytes - byteCount)) throw error('INPUT_TOO_LARGE', `Task input exceeds ${maxBytes} bytes`);
        const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = await handle.stat({ bigint: true });
          if (canonical(statToken(opened)) !== canonical(statToken(stat))) throw error('SNAPSHOT_DRIFT', `Input changed while opening: ${relative}`);
          // Read at most one byte beyond the budget even if an input grows concurrently.
          const limit = maxBytes - byteCount;
          const buffer = Buffer.alloc(Math.min(Number(opened.size), limit) + 1);
          let size = 0;
          while (size < buffer.length) {
            checkAbort(signal);
            const read = await handle.read(buffer, size, buffer.length - size, size);
            if (!read.bytesRead) break;
            size += read.bytesRead;
          }
          if (size > limit) throw error('INPUT_TOO_LARGE', `Task input exceeds ${maxBytes} bytes`);
          const bytes = buffer.subarray(0, size);
          let text;
          try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
          catch { throw error('INPUT_ENCODING_INVALID', `Input is not valid UTF-8: ${relative}`); }
          const afterRead = await handle.stat({ bigint: true });
          if (canonical(statToken(afterRead)) !== canonical(statToken(stat)) || size !== Number(stat.size)) {
            throw error('SNAPSHOT_DRIFT', `Input changed while reading: ${relative}`);
          }
          files.set(relative, { path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: size, text });
          byteCount += size;
        } finally { await handle.close(); }
      } else {
        if (directories.has(relative)) return type;
        const names = (await fs.readdir(absolute)).sort();
        const entries = [];
        directories.set(relative, { path: relative, entries });
        for (const name of names) {
          const child = relative === '.' ? name : `${relative}/${name}`;
          // Check discovered names too; do not silently skip entries.
          if (normalized(child, false) !== child) throw error('INPUT_PATH_INVALID', `Filesystem entry cannot be represented as a normalized input path: ${child}`);
          const childType = await visit(child);
          entries.push({ path: child, type: childType });
        }
      }
      return type;
    }
    for (const relative of requestedFiles) await visit(relative, 'file');
    for (const relative of requestedDirs) await visit(relative, 'directory');
    return {
      files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')),
      directories: [...directories.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')),
      tokens: [...tokens.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')),
      permissionPaths: [...permissionPaths].sort(), bytes: byteCount,
    };
  }

  const first = await scan();
  const permissions = await permissionsFor(first.permissionPaths, permissionProvider, signal);
  const second = await scan();
  const permissionsAfter = await permissionsFor(second.permissionPaths, permissionProvider, signal);
  const finalRoot = await fs.lstat(root, { bigint: true });
  const comparable = snapshot => ({ files: snapshot.files, directories: snapshot.directories, tokens: snapshot.tokens, permissionPaths: snapshot.permissionPaths });
  if (finalRoot.dev !== rootStat.dev || finalRoot.ino !== rootStat.ino ||
      stableDigest(comparable(first)) !== stableDigest(comparable(second)) || stableDigest(permissions) !== stableDigest(permissionsAfter)) {
    throw error('SNAPSHOT_DRIFT', 'Input content, directory entries, or permissions changed during snapshot');
  }
  checkAbort(signal);
  const assurance = { verified: permissions.verified, reasons: permissions.reasons };
  const snapshot = { repoIdentity, files: first.files, directories: first.directories, permissions, assurance, bytes: first.bytes };
  return { ...snapshot, digest: stableDigest(snapshot) };
}
