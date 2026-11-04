import crypto from 'node:crypto';

export const MAX_IDENTIFIER_LENGTH = 256;
const SEGMENT_SPECIALS = /[%:\uD800-\uDFFF]/;
const IDENTIFIER_SPECIALS = /[%:~\uD800-\uDFFF]/;

// Percent and the delimiter are escaped to keep fields distinct. Lone UTF-16
// surrogates are escaped too: Redis UTF-8 encoding would otherwise replace
// different invalid surrogates with the same replacement character.
function escapeSegment(value, escapeTilde = false) {
  const text = String(value);
  if (!(escapeTilde ? IDENTIFIER_SPECIALS : SEGMENT_SPECIALS).test(text)) return text;
  return text.replace(/[%:~\uD800-\uDFFF]/g, (char, index) => {
    if (char === '%') return '%25';
    if (char === ':') return '%3A';
    if (char === '~') return escapeTilde ? '%7E' : char;
    const code = char.charCodeAt(0);
    const pairedHigh = code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xDC00 && text.charCodeAt(index + 1) <= 0xDFFF;
    const pairedLow = code >= 0xDC00 && code <= 0xDFFF && index > 0 &&
      text.charCodeAt(index - 1) >= 0xD800 && text.charCodeAt(index - 1) <= 0xDBFF;
    return pairedHigh || pairedLow ? char : `%u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  });
}

export function escapeKeySegment(value) {
  return escapeSegment(value);
}

function escapeIdentifier(value) {
  return escapeSegment(value, true);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashIdentifier(value) {
  // UTF-8 replaces malformed UTF-16, so hash its code units in a separate
  // namespace to keep different malformed identifiers distinct.
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    return `~u~${crypto.createHash('sha256').update(value, 'utf16le').digest('hex')}`;
  }
  return `~h~${sha256(value)}`;
}

export function buildRateLimitKey({
  prefix = 'limitforge',
  algorithm = 'fixed-window',
  method = 'GET',
  route = '/',
  clientIdentifier = '127.0.0.1',
  hashClientIdentifier = false
} = {}) {
  const cleanPrefix = escapeKeySegment((prefix && String(prefix).trim()) ? String(prefix).trim() : 'limitforge');
  const cleanMethod = escapeKeySegment((method || 'GET').toUpperCase());
  const cleanRoute = escapeKeySegment((route || '/').split('?')[0] || '/');
  const rawId = clientIdentifier && String(clientIdentifier).trim()
    ? String(clientIdentifier).trim()
    : '127.0.0.1';

  let cleanId;
  if (hashClientIdentifier === true) {
    cleanId = hashIdentifier(rawId);
  } else if (typeof hashClientIdentifier === 'function') {
    const customId = String(hashClientIdentifier(rawId) || rawId);
    const escapedId = escapeIdentifier(customId);
    const tag = '~c~';
    if (tag.length + escapedId.length > MAX_IDENTIFIER_LENGTH) {
      const digest = sha256(JSON.stringify([rawId, customId]));
      const available = MAX_IDENTIFIER_LENGTH - tag.length - digest.length - 1;
      cleanId = `${tag}${escapedId.slice(0, available)}~${digest}`;
    } else {
      cleanId = `${tag}${escapedId}`;
    }
  } else {
    const escapedId = escapeIdentifier(rawId);
    cleanId = escapedId.length > MAX_IDENTIFIER_LENGTH ? hashIdentifier(rawId) : escapedId;
  }

  if (algorithm && algorithm !== 'fixed-window') {
    return `${cleanPrefix}:${escapeKeySegment(algorithm)}:${cleanMethod}:${cleanRoute}:${cleanId}`;
  }

  return `${cleanPrefix}:${cleanMethod}:${cleanRoute}:${cleanId}`;
}

export default buildRateLimitKey;
