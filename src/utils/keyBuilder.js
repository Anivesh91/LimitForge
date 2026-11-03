import crypto from 'node:crypto';

export const MAX_IDENTIFIER_LENGTH = 256;

export function buildRateLimitKey({
  prefix = 'limitforge',
  algorithm = 'fixed-window',
  method = 'GET',
  route = '/',
  clientIdentifier = '127.0.0.1',
  hashClientIdentifier = false
} = {}) {
  const cleanPrefix = (prefix && String(prefix).trim()) ? String(prefix).trim() : 'limitforge';
  const cleanMethod = (method || 'GET').toUpperCase();
  const cleanRoute = (route || '/').split('?')[0] || '/';
  const rawId = clientIdentifier && String(clientIdentifier).trim()
    ? String(clientIdentifier).trim()
    : '127.0.0.1';

  let cleanId;
  if (hashClientIdentifier === true) {
    cleanId = crypto.createHash('sha256').update(rawId).digest('hex');
  } else if (typeof hashClientIdentifier === 'function') {
    cleanId = String(hashClientIdentifier(rawId) || rawId);
    if (cleanId.length > MAX_IDENTIFIER_LENGTH) {
      const digest = crypto.createHash('sha256').update(rawId).digest('hex');
      cleanId = `${cleanId.slice(0, MAX_IDENTIFIER_LENGTH - digest.length - 1)}:${digest}`;
    }
  } else if (rawId.length > MAX_IDENTIFIER_LENGTH) {
    cleanId = crypto.createHash('sha256').update(rawId).digest('hex');
  } else {
    cleanId = rawId;
  }

  if (algorithm && algorithm !== 'fixed-window') {
    return `${cleanPrefix}:${algorithm}:${cleanMethod}:${cleanRoute}:${cleanId}`;
  }

  return `${cleanPrefix}:${cleanMethod}:${cleanRoute}:${cleanId}`;
}

export default buildRateLimitKey;
