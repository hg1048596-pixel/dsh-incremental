import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

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
  const packages = await Promise.all(PACKAGES.map(async ([name, required]) => {
    try {
      const metadataPath = require.resolve(`${name}/package.json`);
      const entry = await realpath(require.resolve(name));
      const relative = path.relative(path.join(root, 'node_modules'), entry);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Resolved outside runtime');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      const bytes = await readFile(entry);
      const exports = await import(pathToFileURL(entry).href);
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
  const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
  const supportedNode=nodeMajor>22||(nodeMajor===22&&nodeMinor>=13);
  return {
    runtimeRoot: root, appVersion, dshVersion, nodeVersion: process.versions.node,
    supportedNode,
    compatible: supportedNode && packages.every((item) => item.compatible),
    packages,
    capabilities: {
      publicToolOutputContract: 'output.schema + output.render + canonical JSON execute result',
      independentRoot: true, modelRevision: 'config_only', strictReuseEligible: false,
      background: false, modelCalls: 0, credentialResolution: false, coreWrites: false,
    },
  };
}

export const doctor = inspectDshRuntime;
