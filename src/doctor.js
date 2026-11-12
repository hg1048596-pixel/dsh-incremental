import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { deepSeekTransport, minimumDshNodeVersion, supportsDshNode } from './dsh-runtime.js';

const PACKAGES = [
  ['@deepseek-ai/cordis', ['Context', 'Service']],
  ['@deepseek-ai/dsh-tools', ['defineTool', 'ToolRuntime']],
  ['@deepseek-ai/dsh-llm', ['LlmRuntime', 'LlmAdapter', 'createUserMessage']],
  ['@deepseek-ai/dsh-llm-deepseek', ['DeepSeekAdapter', 'resolveAdapterOptions']],
  ['@deepseek-ai/dsh-llm-pi-ai', ['PiAiAdapter', 'apply']],
  ['@deepseek-ai/dsh-credentials', ['CredentialProvider']],
];

/** Read installed metadata and public exports, without booting DSH or resolving secrets. */
export async function inspectDshRuntime({ runtimeRoot } = {}) {
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) throw new Error('doctor requires an explicit absolute runtimeRoot');
  const root = await realpath(runtimeRoot);
  const require = createRequire(path.join(root, 'package.json'));
  let runtimeVersion;
  try { runtimeVersion = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-llm/package.json'), 'utf8')).version; } catch { /* report missing package below */ }
  const requiredNode = minimumDshNodeVersion(runtimeVersion);
  const supportedNode = supportsDshNode(runtimeVersion);
  let transport = null;
  const packages = await Promise.all(PACKAGES.map(async ([name, required]) => {
    try {
      const metadataPath = require.resolve(`${name}/package.json`);
      const entry = await realpath(require.resolve(name));
      const relative = path.relative(path.join(root, 'node_modules'), entry);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Resolved outside runtime');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      const bytes = await readFile(entry);
      if (!supportedNode) return {
        name, version: metadata.version, entry, sha256: createHash('sha256').update(bytes).digest('hex'),
        modificationStatus: 'unknown_no_trusted_baseline', compatible: false, error: 'NODE_VERSION_UNSUPPORTED',
      };
      const exports = await import(pathToFileURL(entry).href);
      if (name === '@deepseek-ai/dsh-llm-deepseek') transport = deepSeekTransport(exports);
      const capabilities = Object.fromEntries(required.map((key) => [key, typeof exports[key] === 'function']));
      return {
        name, version: metadata.version, entry,
        sha256: createHash('sha256').update(bytes).digest('hex'), capabilities,
        modificationStatus: 'unknown_no_trusted_baseline', compatible: Object.values(capabilities).every(Boolean),
      };
    } catch {
      return { name, compatible: false, error: 'PACKAGE_UNAVAILABLE_OR_PUBLIC_API_MISMATCH' };
    }
  }));
  let appVersion = null;
  try { appVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version ?? null; } catch { /* metadata only */ }
  let dshVersion = null;
  try { dshVersion = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version ?? null; } catch { /* metadata only; never boot the product entry */ }
  return {
    runtimeRoot: root, appVersion, dshVersion, nodeVersion: process.versions.node, requiredNode,
    supportedNode,
    compatible: supportedNode && packages.every((item) => item.compatible),
    packages,
    capabilities: {
      publicToolOutputContract: 'output.schema + output.render + canonical JSON execute result',
      deepSeekTransport: transport,
      independentRoot: true, modelRevision: 'config_only', strictReuseEligible: false,
      background: false, modelCalls: 0, credentialResolution: false, coreWrites: false,
    },
  };
}

export const doctor = inspectDshRuntime;
