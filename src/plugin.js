import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDshExecutor, validateDshConfiguration } from './dsh-executor.js';
import { planReview, runReview } from './engine.js';
import { readManifest } from './manifest.js';
import { CacheStore } from './cache.js';
import { renderReport } from './report.js';

export const name = 'incremental';
export const inject = ['tools'];

function canonical(value) { return JSON.parse(JSON.stringify(value)); }

/** Snapshot only public policy facts. These observations do not grant remote access. */
export async function resolveHostSecurityPolicy(ctx, config, exec = {}) {
  const session = exec.agent?.session;
  let sandbox = { status: 'unknown', reason: 'sandbox_policy_unavailable' };
  try {
    const service = ctx.get?.('sandboxPolicy');
    if (typeof service?.resolve === 'function') {
      const resolved = await service.resolve({ session });
      const extraRoots = resolved?.additionalWritableRoots;
      if (resolved && ['read-only', 'workspace-write', 'danger-full-access'].includes(resolved.mode)
        && typeof resolved.workspaceRoot === 'string' && path.isAbsolute(resolved.workspaceRoot)
        && (extraRoots === undefined || (Array.isArray(extraRoots)
          && extraRoots.every((root) => typeof root === 'string' && path.isAbsolute(root) && !root.includes('\0'))))) {
        sandbox = {
          status: 'known', mode: resolved.mode, workspaceRoot: resolved.workspaceRoot,
          sessionBound: session !== undefined,
          ...(typeof resolved.sessionId === 'string' ? { sessionId: resolved.sessionId } : {}),
          ...(extraRoots === undefined ? {} : { additionalWritableRoots: [...new Set(extraRoots)].sort() }),
        };
      } else sandbox = { status: 'unknown', reason: 'sandbox_policy_invalid' };
    }
  } catch { sandbox = { status: 'unknown', reason: 'sandbox_policy_resolution_failed' }; }
  let approval = { status: 'unknown', reason: 'approval_policy_unavailable' };
  try {
    const service = ctx.get?.('approval');
    if (service) {
      if (session !== undefined && typeof service.overrideOf !== 'function') {
        approval = { status: 'unknown', reason: 'approval_session_policy_unavailable' };
      } else {
        const override = session === undefined ? undefined : await service.overrideOf(session);
        const policy = override ?? service.config?.policy;
        approval = ['ask', 'never'].includes(policy)
          ? { status: 'known', effectivePolicy: policy, source: override === undefined ? 'configured_default' : 'session_override' }
          : { status: 'unknown', reason: 'approval_policy_invalid' };
      }
    }
  } catch { approval = { status: 'unknown', reason: 'approval_policy_resolution_failed' }; }
  return canonical({
    allowRemote: config.allowRemote === true, approvedRepoRoot: config.repoRoot,
    authorizationSource: 'fixed_host_configuration', sandbox, approval,
  });
}

/** Fixed host configuration is the sole source of paths, routing and approval. */
export async function apply(ctx, input) {
  if (input === undefined || input === null || (typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0)) {
    ctx.logger?.warn?.('incremental is dormant: configure fixed repoRoot, manifestPath, stateDir, runtimeRoot and model connection before enabling its tools');
    return;
  }
  for (const key of ['repoRoot', 'manifestPath', 'stateDir', 'runtimeRoot']) {
    if (!input || typeof input[key] !== 'string' || !path.isAbsolute(input[key])) throw new Error(`incremental requires absolute host configuration: ${key}`);
  }
  const config = Object.freeze({ ...structuredClone(input), repoRoot: await realpath(input.repoRoot) });
  if (config.background === true) throw new Error('incremental background mode is unavailable: this host has no per-job quiet delivery contract');
  const executorConfig = validateDshConfiguration({ ...config, approvedRepoRoot: config.repoRoot });
  const require = createRequire(path.join(config.runtimeRoot, 'package.json'));
  const toolEntry = await realpath(require.resolve('@deepseek-ai/dsh-tools'));
  const relativeToolEntry = path.relative(path.join(await realpath(config.runtimeRoot), 'node_modules'), toolEntry);
  if (relativeToolEntry.startsWith('..') || path.isAbsolute(relativeToolEntry)) throw new Error('Runtime package resolved outside the approved installation');
  const { defineTool } = await import(pathToFileURL(toolEntry).href);
  if (typeof defineTool !== 'function') throw new Error('incremental requires the public defineTool API');
  const controllers = new Set();
  const operations = new Set();
  let disposed = false;
  let disposal;
  let executor;
  const getExecutor = () => executor ??= createDshExecutor({ ...executorConfig, budget: config.budget }, {
    resolveCredential: async (reference) => {
      if (reference !== config.credentialEnv) throw new Error('Credential reference denied');
      const provider = ctx.get?.('credentials');
      return provider ? (await provider.resolve(reference))?.value : process.env[reference];
    },
  });
  const run = (operation, args, exec = {}) => {
    if (disposed) return Promise.reject(Object.assign(new Error('incremental plugin disposed'), { code: 'EXECUTOR_DISPOSED' }));
    const controller = new AbortController();
    const abort = () => controller.abort();
    exec.signal?.addEventListener('abort', abort, { once: true });
    if (exec.signal?.aborted) controller.abort();
    controllers.add(controller);
    const assertRunning = () => {
      if (controller.signal.aborted) throw Object.assign(new Error('incremental operation aborted'), { code: 'ABORTED' });
    };
    const pending = (async () => {
      try {
        assertRunning();
        const manifest = await readManifest(config.manifestPath);
        assertRunning();
        const options = {
          repoRoot: config.repoRoot, manifest, stateDir: config.stateDir,
          executor: await getExecutor(), signal: controller.signal,
          securityPolicy: await resolveHostSecurityPolicy(ctx, config, exec),
        };
        assertRunning();
        return canonical(operation === 'plan' ? await planReview(options) : await runReview({ ...options, full: args.full === true }));
      } finally {
        controllers.delete(controller);
        exec.signal?.removeEventListener('abort', abort);
      }
    })();
    operations.add(pending);
    pending.then(() => operations.delete(pending), () => operations.delete(pending));
    return pending;
  };
  const disposers = [];
  const register = (definition) => disposers.push(ctx.tools.register(defineTool({
    ...definition,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  })));
  try {
    register({
      name: 'incremental_plan',
      description: 'Plan the configured repository review without a model call. Paths and approval are fixed by host configuration.',
      parameters: {}, execute: (_args, exec) => run('plan', {}, exec),
    });
    register({
      name: 'incremental_run',
      description: 'Run the configured repository review in the foreground, under the fixed request budget and host approval.',
      parameters: { full: { type: 'boolean', description: 'Recompute all tasks instead of reusing eligible artifacts.' } },
      execute: (args, exec) => run('run', args, exec),
    });
    register({
      name: 'incremental_report', description: 'Read a saved review report from the configured repository state directory.',
      parameters: { runId: { type: 'string', required: true } },
      execute: async ({ runId }) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error('Invalid runId');
        const report = await new CacheStore(config.stateDir, config.repoRoot).readReport(runId);
        if (!report) throw Object.assign(new Error(`Review report not found: ${runId}`), { code: 'REPORT_NOT_FOUND' });
        return canonical({ runId, report, markdown: renderReport(report) });
      },
    });
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  const dispose = () => {
    if (disposal) return disposal;
    disposed = true;
    for (const controller of controllers) controller.abort();
    for (const unregister of disposers.splice(0).reverse()) unregister();
    disposal = (async () => {
      await Promise.allSettled([...operations]);
      // Initialization failures already dispose their private Cordis root.
      const initialized = executor ? await executor.catch(() => null) : null;
      await initialized?.dispose();
    })();
    return disposal;
  };
  return dispose;
}
