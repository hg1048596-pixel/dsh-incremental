import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const MAX_TOKENS = 4096;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RETRY_POLICY = Object.freeze({ mode: 'normal', maxRetries: 0 });
const OUTPUT_ERROR = Symbol('incremental-output-error');
const FINISH_CODES = Object.freeze({
  stop: 'FINISH_STOP', 'max-tokens': 'FINISH_MAX_TOKENS', 'tool-calls': 'FINISH_TOOL_CALLS',
  error: 'FINISH_ERROR', aborted: 'FINISH_ABORTED',
});

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function positiveInteger(value, fallback, upper, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > upper) throw new Error(`Invalid ${label}`);
  return result;
}

function configSnapshot(input) {
  if (!input || typeof input !== 'object') throw new Error('DSH executor configuration is required');
  for (const name of ['runtimeRoot', 'provider', 'model', 'credentialEnv', 'approvedRepoRoot']) {
    if (typeof input[name] !== 'string' || !input[name].trim()) throw new Error(`Missing DSH configuration: ${name}`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.credentialEnv)) throw new Error('Invalid credential reference');
  if (!input.connection || typeof input.connection !== 'object') throw new Error('A fixed connection is required');
  const adapter = input.connection.adapter ?? (input.provider === 'deepseek-official' ? 'deepseek' : 'pi-ai');
  if (!['deepseek', 'pi-ai'].includes(adapter)) throw new Error('Unsupported adapter');
  const allowed = new Set(['adapter', 'baseURL', 'api', 'thinking', 'reasoningEffort', 'reasoning']);
  if (Object.keys(input.connection).some((key) => !allowed.has(key))) throw new Error('Unsupported connection configuration');
  let endpoint;
  try { endpoint = new URL(input.connection.baseURL); } catch { throw new Error('A fixed absolute baseURL is required'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Invalid connection baseURL');
  }
  if (endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Remote connections require HTTPS');
  }
  const maxTokens = positiveInteger(input.maxTokens, MAX_TOKENS, MAX_TOKENS, 'maxTokens (maximum 4096)');
  const timeoutMs = positiveInteger(input.timeoutMs, 120000, 3600000, 'timeoutMs');
  const maxRequests = positiveInteger(input.maxRequests, 48, 48, 'maxRequests');
  const connection = JSON.parse(JSON.stringify({ ...input.connection, adapter, baseURL: endpoint.href.replace(/\/$/, '') }));
  if (adapter === 'pi-ai' && typeof connection.api !== 'string') throw new Error('The pi-ai connection requires an explicit api protocol');
  return freeze({
    runtimeRoot: path.resolve(input.runtimeRoot), provider: input.provider, model: input.model,
    connection, credentialEnv: input.credentialEnv, approvedRepoRoot: path.resolve(input.approvedRepoRoot),
    allowRemote: input.allowRemote === true, maxTokens, timeoutMs, maxRequests,
  });
}

/** Validate a host configuration without importing a runtime or resolving a key. */
export function validateDshConfiguration(input) { return configSnapshot(input); }

/** Resolve only public package roots from the explicitly selected installed runtime. */
export async function loadDshModules(runtimeRoot) {
  const root = await realpath(runtimeRoot);
  const require = createRequire(path.join(root, 'package.json'));
  const names = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-llm-pi-ai'];
  const entries = await Promise.all(names.map(async (name) => {
    const entry = require.resolve(name);
    const relative = path.relative(path.join(root, 'node_modules'), await realpath(entry));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Runtime package resolved outside the approved installation');
    const metadata = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'));
    return [name, { exports: await import(pathToFileURL(entry).href), version: metadata.version, entry }];
  }));
  return Object.fromEntries(entries);
}

function outputError(code, usage = null, modelCalls = 0) {
  const error = new Error(`DSH review failed: ${code}`);
  error.code = code;
  error[OUTPUT_ERROR] = true;
  error.usage = usage;
  error.modelCalls = modelCalls;
  return error;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Strict data contract: parsing never evaluates text, invokes tools, or repairs JSON. */
export function validateReviewOutput(value) {
  if (!exactKeys(value, ['summary', 'findings', 'unknownDependencies', 'limitations'])
    || typeof value.summary !== 'string' || !Array.isArray(value.findings)
    || !Array.isArray(value.unknownDependencies) || !value.unknownDependencies.every((item) => typeof item === 'string')
    || !Array.isArray(value.limitations) || !value.limitations.every((item) => typeof item === 'string')) {
    throw outputError('INVALID_OUTPUT');
  }
  for (const finding of value.findings) {
    if (!exactKeys(finding, ['title', 'path', 'line', 'evidence', 'severity'])
      || !['title', 'path', 'evidence'].every((key) => typeof finding[key] === 'string')
      || !Number.isSafeInteger(finding.line) || finding.line < 1
      || !['low', 'medium', 'high'].includes(finding.severity)) throw outputError('INVALID_OUTPUT');
  }
  return value;
}

function normalizedUsage(value) {
  if (!value || typeof value !== 'object') throw outputError('INVALID_USAGE');
  const usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const number = value[key];
    if (number !== undefined && (!Number.isSafeInteger(number) || number < 0)) throw outputError('INVALID_USAGE');
    usage[key] = number ?? null;
  }
  return usage;
}

function validateRequest(request) {
  if (!exactKeys(request, ['system', 'messages', 'tools']) || typeof request.system !== 'string'
    || !Array.isArray(request.tools) || request.tools.length !== 0
    || !Array.isArray(request.messages) || request.messages.length === 0) throw outputError('INVALID_REQUEST');
  for (const message of request.messages) {
    if (!exactKeys(message, ['role', 'content']) || message.role !== 'user' || !Array.isArray(message.content)
      || message.content.length === 0 || !message.content.every((block) => exactKeys(block, ['type', 'text'])
        && block.type === 'text' && typeof block.text === 'string')) throw outputError('INVALID_REQUEST');
  }
  return freeze(structuredClone(request));
}

/**
 * Construct a private Cordis root. Host llm hooks, history, tools, settings and retries
 * are deliberately not parameters. Test dependencies may provide an adapter factory.
 */
export async function createDshExecutor(input, dependencies = {}) {
  const config = configSnapshot(input);
  const modules = await loadDshModules(config.runtimeRoot);
  const { Context } = modules['@deepseek-ai/cordis'].exports;
  const llmModule = modules['@deepseek-ai/dsh-llm'].exports;
  const { CredentialProvider } = modules['@deepseek-ai/dsh-credentials'].exports;
  const root = new Context();
  const budget = input.budget;
  if (budget && (!Number.isSafeInteger(budget.used) || budget.used < 0 || !Number.isSafeInteger(budget.max) || budget.max < 1 || budget.max > 48 || budget.used > budget.max)) {
    throw new Error('Invalid shared request budget');
  }
  const resolveCredential = async (reference) => {
    if (reference !== config.credentialEnv) throw outputError('CREDENTIAL_REF_DENIED');
    const candidate = dependencies.resolveCredential
      ? await dependencies.resolveCredential(reference)
      : process.env[reference];
    const value = typeof candidate === 'string' ? candidate.trim() : undefined;
    if (!value || !/^[\x21-\x7e]+$/.test(value)) throw outputError('MISSING_CREDENTIAL');
    return value;
  };
  class RestrictedCredentials extends CredentialProvider {
    async resolve(reference) { return { value: await resolveCredential(reference), source: 'approved-reference' }; }
    async describe(reference) { if (reference !== config.credentialEnv) throw outputError('CREDENTIAL_REF_DENIED'); return { configured: false, writable: false }; }
    async set() { throw outputError('CREDENTIAL_WRITE_DENIED'); }
    async unset() { throw outputError('CREDENTIAL_WRITE_DENIED'); }
  }
  try {
    await root.plugin(llmModule.LlmRuntime);
    await root.plugin(RestrictedCredentials);
    if (dependencies.createAdapter) {
      const adapter = await dependencies.createAdapter({ config, modules, resolveCredential });
      root.llm.registerAdapter([config.provider], adapter);
    } else if (config.connection.adapter === 'deepseek') {
      const { DeepSeekAdapter, resolveAdapterOptions } = modules['@deepseek-ai/dsh-llm-deepseek'].exports;
      const connection = freeze(resolveAdapterOptions({
        apiKeyEnv: config.credentialEnv, baseURL: config.connection.baseURL,
        thinking: config.connection.thinking, reasoningEffort: config.connection.reasoningEffort,
        maxTokens: config.maxTokens, streamIdleTimeoutMs: config.timeoutMs, retryPolicy: RETRY_POLICY,
        models: [{ id: config.model, maxTokens: config.maxTokens }],
      }));
      const userId = randomUUID();
      root.llm.registerAdapter([config.provider], new DeepSeekAdapter({
        options: () => connection,
        resolveApiKey: (snapshot) => resolveCredential(snapshot.apiKeyEnv),
        resolveUserId: () => userId,
      }));
    } else {
      // Public plugin entry builds PiAiAdapter using its internal profile validator.
      // A named credential and the restricted service prohibit pi-ai ambient auth.
      const profile = freeze({
        apiKeyEnv: config.credentialEnv, baseURL: config.connection.baseURL, api: config.connection.api,
        models: [{ id: config.model, maxTokens: config.maxTokens }], defaultInput: ['text'],
        reasoning: config.connection.reasoning, timeoutMs: config.timeoutMs,
        streamIdleTimeoutMs: config.timeoutMs, retryPolicy: RETRY_POLICY,
      });
      await root.plugin(modules['@deepseek-ai/dsh-llm-pi-ai'].exports, { providers: { [config.provider]: profile } });
    }
  } catch {
    await root.fiber.dispose();
    throw outputError('RUNTIME_INITIALIZATION_FAILED');
  }
  const identity = freeze({
    kind: 'dsh', version: modules['@deepseek-ai/dsh-llm'].version,
    model: { provider: config.provider, id: config.model, immutableRevision: null, assurance: 'config_only' },
    adapter: config.connection.adapter, connection: config.connection, maxTokens: config.maxTokens, timeoutMs: config.timeoutMs,
    isolation: 'independent_cordis_root', protocol: 'structured_review_v1',
    runnerHash: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    runtimeHashes: Object.fromEntries(await Promise.all([
      '@deepseek-ai/dsh-llm', `@deepseek-ai/dsh-llm-${config.connection.adapter === 'deepseek' ? 'deepseek' : 'pi-ai'}`,
    ].map(async (name) => [name, createHash('sha256').update(await readFile(modules[name].entry)).digest('hex')]))),
  });
  let dispatched = 0;
  let disposed = false;
  let disposal;
  const active = new Set();
  return {
    identity,
    reuseEligibility: freeze({ eligible: false, reasons: ['model_revision_unknown'] }),
    async execute({ request, repoRoot, signal }) {
      if (disposed) throw outputError('EXECUTOR_DISPOSED');
      if (!config.allowRemote) throw outputError('REMOTE_NOT_APPROVED');
      const frozenRequest = validateRequest(request);
      if (!repoRoot || await realpath(repoRoot) !== await realpath(config.approvedRepoRoot)) throw outputError('REPOSITORY_NOT_APPROVED');
      // dispose() can run while the filesystem validation above is pending.
      if (disposed) throw outputError('EXECUTOR_DISPOSED');
      if (signal?.aborted) throw outputError('ABORTED');
      if (dispatched >= config.maxRequests || (budget && budget.used >= budget.max)) throw outputError('REQUEST_BUDGET_EXHAUSTED');
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      signal?.addEventListener('abort', forwardAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      timer.unref?.();
      const tracker = { controller, done: null };
      active.add(tracker);
      let settle;
      tracker.done = new Promise((resolve) => { settle = resolve; });
      let usage = null;
      let calls = 0;
      try {
        const options = freeze({
          ...frozenRequest, provider: config.provider, model: config.model,
          maxTokens: config.maxTokens,
          messages: frozenRequest.messages.map((message) => llmModule.createUserMessage({
            content: structuredClone(message.content), source: { kind: 'user' },
          })),
        });
        // AbortSignal is a live capability, so it is not included in the frozen data.
        const stream = root.llm.stream({ ...options, signal: controller.signal });
        dispatched += 1;
        if (budget) budget.used += 1;
        calls = 1;
        const blocks = new Map();
        const completedBlocks = new Set();
        const texts = [];
        let bytes = 0;
        let finish = null;
        for await (const chunk of stream) {
          if (controller.signal.aborted) throw outputError('ABORTED');
          if (!chunk || typeof chunk !== 'object' || finish) throw outputError('INVALID_STREAM');
          if (chunk.type === 'usage') {
            if (usage !== null) throw outputError('INVALID_USAGE');
            usage = normalizedUsage(chunk.usage);
          } else if (chunk.type === 'finish') {
            if (blocks.size || chunk.reason?.kind !== 'stop') throw outputError(Object.hasOwn(FINISH_CODES, chunk.reason?.kind)
              ? FINISH_CODES[chunk.reason.kind] : 'FINISH_UNKNOWN');
            finish = { kind: 'stop' };
          } else if (chunk.type === 'block-start') {
            if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || blocks.has(chunk.index) || completedBlocks.has(chunk.index)
              || !['text', 'reasoning'].includes(chunk.blockType)) throw outputError('UNEXPECTED_BLOCK');
            blocks.set(chunk.index, { type: chunk.blockType, text: '' });
          } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
            const block = blocks.get(chunk.index);
            if (!block || chunk.type !== `${block.type}-delta` || typeof chunk.text !== 'string') throw outputError('INVALID_STREAM');
            block.text += chunk.text;
            bytes += Buffer.byteLength(chunk.text);
          } else if (chunk.type === 'block-end') {
            const block = blocks.get(chunk.index);
            if (!block || chunk.block?.type !== block.type || typeof chunk.block.text !== 'string'
              || (block.text && block.text !== chunk.block.text)) throw outputError('UNEXPECTED_BLOCK');
            bytes += Buffer.byteLength(chunk.block.text);
            if (block.type === 'text') texts.push({ index: chunk.index, text: chunk.block.text });
            blocks.delete(chunk.index);
            completedBlocks.add(chunk.index);
          } else throw outputError('UNEXPECTED_BLOCK');
          if (bytes > MAX_RESPONSE_BYTES) throw outputError('RESPONSE_TOO_LARGE');
        }
        if (!finish || !texts.length) throw outputError('INCOMPLETE_RESPONSE');
        let output;
        try { output = JSON.parse(texts.sort((a, b) => a.index - b.index).map((block) => block.text).join('')); }
        catch { throw outputError('INVALID_JSON'); }
        validateReviewOutput(output);
        return { output, usage, modelCalls: calls, finishReason: finish, validation: { schema: 'structured_review_v1', valid: true } };
      } catch (error) {
        throw outputError(controller.signal.aborted ? 'ABORTED' : (error?.[OUTPUT_ERROR] ? error.code : 'MODEL_REQUEST_FAILED'), usage, calls);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
        active.delete(tracker);
        settle();
      }
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      disposal = (async () => {
        for (const tracker of active) tracker.controller.abort();
        await Promise.all([...active].map((tracker) => tracker.done));
        await root.fiber.dispose();
      })();
      return disposal;
    },
  };
}
