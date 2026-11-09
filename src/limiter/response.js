export function setDegradedHeader(res) {
  if (typeof res.setHeader === 'function' && !res.headersSent) {
    res.setHeader('RateLimit-Degraded', 'true');
  }
}

export function setRateLimitHeaders(res, { limit, remaining, reset, retryAfter, standardHeaders }) {
  if (typeof res.setHeader !== 'function' || res.headersSent) return;

  if (standardHeaders) {
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
    res.setHeader('RateLimit-Reset', String(Math.max(1, reset)));
  }

  if (retryAfter !== undefined) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
  }
}

export async function sendBlockedResponse({ req, res, statusCode, message, retryAfter }) {
  const blockedStatus = typeof statusCode === 'number' ? statusCode : 429;
  let body;

  if (typeof message === 'function') {
    body = await message(req, res);
  } else if (typeof message === 'object' && message !== null) {
    body = message;
  } else {
    body = {
      success: false,
      message: typeof message === 'string' ? message : 'Too many requests',
      retryAfter
    };
  }

  return res.status(blockedStatus).json(body);
}
