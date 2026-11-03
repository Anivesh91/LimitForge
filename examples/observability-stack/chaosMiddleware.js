/**
 * Security middleware guarding chaos testing endpoints.
 * Prevents unauthorized or unintentional activation of chaos states.
 */
export const checkChaosAllowed = (req, res, next) => {
  const allowChaosRaw = String(process.env.ALLOW_CHAOS ?? '').trim().toLowerCase();
  const isChaosExplicitlyAllowed = allowChaosRaw === 'true' || allowChaosRaw === '1';
  const secret = process.env.CHAOS_SECRET;

  if (process.env.NODE_ENV === 'production') {
    if (!isChaosExplicitlyAllowed) {
      return res.status(403).json({ error: 'Chaos testing is disabled in production' });
    }
    if (!secret || req.headers?.['x-chaos-secret'] !== secret) {
      return res.status(401).json({ error: 'Unauthorized: CHAOS_SECRET is required and must match in production' });
    }
  } else {
    if (secret && req.headers?.['x-chaos-secret'] !== secret) {
      return res.status(401).json({ error: 'Unauthorized: Invalid x-chaos-secret' });
    }
  }
  next();
};
