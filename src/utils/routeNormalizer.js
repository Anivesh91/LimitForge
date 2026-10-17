

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMERIC_SEGMENT_REGEX = /\/\d+(?=\/|$)/g;
const LONG_HEX_HASH_REGEX = /\/[0-9a-fA-F]{16,}(?=\/|$)/g;
const ULID_REGEX = /\/[0-7][0-9A-HJKMNP-TV-Z]{25}(?=\/|$)/gi;
const CUID_REGEX = /\/c[0-9a-z]{24}(?=\/|$)/gi;

export function sanitizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return '/';
  }

  // strip query parameters
  const pathWithoutQuery = rawPath.split('?')[0];

  const sanitized = pathWithoutQuery
    .replace(UUID_REGEX, ':id')
    .replace(ULID_REGEX, '/:id')
    .replace(CUID_REGEX, '/:id')
    .replace(NUMERIC_SEGMENT_REGEX, '/:id')
    .replace(LONG_HEX_HASH_REGEX, '/:id')
    .replace(/\/+/g, '/');

  return sanitized || '/';
}

export function normalizeRoute(req, customNormalizer) {
  if (typeof customNormalizer === 'function') {
    try {
      const custom = customNormalizer(req);
      if (typeof custom === 'string' && custom.length > 0) {
        return sanitizePath(custom);
      }
    } catch {
    }
  }

  if (!req || typeof req !== 'object') {
    return '/';
  }

  if (req.route && typeof req.route.path === 'string') {
    const base = req.baseUrl || '';
    const route = req.route.path;
    const combined = `${base}${route}`.replace(/\/+/g, '/');
    return combined || '/';
  }

  const fallbackPath = `${req.baseUrl || ''}${req.path || req.originalUrl || '/'}`;
  return sanitizePath(fallbackPath);
}
