/** Minimum host Node version for the supported public DSH release families. */
export function minimumDshNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\./.exec(version ?? '');
  return match && (Number(match[1]) > 0 || Number(match[2]) >= 2) ? '24.9.0' : '22.13.0';
}

export function supportsDshNode(version, nodeVersion = process.versions.node) {
  const actual = nodeVersion.split('.').map(Number);
  const minimum = minimumDshNodeVersion(version).split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (!Number.isSafeInteger(actual[index])) return false;
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

/** Public exports distinguish the two supported DeepSeek transport contracts. */
export function deepSeekTransport(exports) {
  const messages = typeof exports.DeepSeekFileStore === 'function';
  if (messages !== (typeof exports.modelListingURL === 'function')) throw new Error('Unsupported DeepSeek public transport contract');
  return messages ? 'deepseek-messages' : 'deepseek-chat-completions';
}
