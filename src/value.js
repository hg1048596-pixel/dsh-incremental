import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new TypeError('Non-JSON value');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const clone = value => JSON.parse(JSON.stringify(value));
export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function abortIfNeeded(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Operation cancelled'), { code: 'CANCELLED' });
}
export function problem(code, message, sourceTaskId) {
  return { code, message, ...(sourceTaskId ? { sourceTaskId } : {}) };
}
export function errorInfo(error) {
  return { code: error?.code || 'EXECUTION_FAILED', message: String(error?.message || error).slice(0,4000) };
}
