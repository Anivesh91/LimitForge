import { Router } from 'express';
import { createClient } from 'redis';
import { rateLimiter, RedisStore } from '../../src/index.js';
import {
  testController,
  loginController,
  publicController
} from './controllers.js';

const router = Router();
const REDIS_URL = process.env.REDIS_URL;

let sharedStore;
let redisClient = null;

if (REDIS_URL) {
  try {
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => {
      console.warn('[RateShield Demo] Redis connection warning:', err.message);
    });
    await redisClient.connect().catch((err) => {
      console.warn('[RateShield Demo] Redis unreachable, falling back to MemoryStore:', err.message);
      redisClient = null;
    });

    if (redisClient && redisClient.isOpen) {
      sharedStore = new RedisStore({ client: redisClient });
      console.log(`[RateShield Demo] Connected to Redis at ${REDIS_URL} (Distributed Rate Limiting Active)`);
    }
  } catch (err) {
    console.warn('[RateShield Demo] Redis initialization failed, using MemoryStore fallback:', err.message);
  }
}

/**
 * Route 1: GET /api/test
 * Policy: 5 requests per 60 seconds
 */
router.get(
  '/test',
  rateLimiter({
    limit: 5,
    windowMs: 60_000,
    store: sharedStore
  }),
  testController
);

/**
 * Route 2: POST /api/login
 * Policy: 3 requests per 60 seconds (Simulates strict endpoint protection)
 */
router.post(
  '/login',
  rateLimiter({
    limit: 3,
    windowMs: 60_000,
    store: sharedStore
  }),
  loginController
);

/**
 * Route 3: GET /api/public
 * Policy: 10 requests per 60 seconds (Simulates higher allowance public endpoint)
 */
router.get(
  '/public',
  rateLimiter({
    limit: 10,
    windowMs: 60_000,
    store: sharedStore
  }),
  publicController
);

/**
 * Route 4: GET /api/distributed
 * Demonstrates shared distributed quota across instances
 */
router.get(
  '/distributed',
  rateLimiter({
    limit: 5,
    windowMs: 60_000,
    store: sharedStore
  }),
  (req, res) => {
    res.json({
      success: true,
      message: 'Distributed rate-limited endpoint reached',
      store: redisClient && redisClient.isOpen ? 'redis' : 'memory',
      clientIp: req.ip
    });
  }
);

/**
 * Route 5: GET /api/status
 * Healthcheck & runtime store status
 */
router.get('/status', (req, res) => {
  res.json({
    status: 'online',
    package: 'rateshield',
    store: redisClient && redisClient.isOpen ? 'redis' : 'memory',
    redisConnected: Boolean(redisClient && redisClient.isOpen),
    clientIp: req.ip
  });
});

export default router;
