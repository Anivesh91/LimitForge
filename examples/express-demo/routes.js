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

router.get(
  '/test',
  rateLimiter({
    limit: 5,
    windowMs: 60_000,
    store: sharedStore
  }),
  testController
);

router.post(
  '/login',
  rateLimiter({
    limit: 3,
    windowMs: 60_000,
    store: sharedStore
  }),
  loginController
);

router.get(
  '/public',
  rateLimiter({
    limit: 10,
    windowMs: 60_000,
    store: sharedStore
  }),
  publicController
);

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

router.get('/status', (req, res) => {
  res.json({
    status: 'online',
    package: 'limitforge',
    store: redisClient && redisClient.isOpen ? 'redis' : 'memory',
    redisConnected: Boolean(redisClient && redisClient.isOpen),
    clientIp: req.ip
  });
});

export default router;
