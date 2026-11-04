import { Router } from 'express';
import { createClient } from 'redis';
import { rateLimiter, RedisStore, ResilientStore } from '../../src/index.js';
import {
  testController,
  loginController,
  publicController
} from './controllers.js';

const router = Router();
const REDIS_URL = process.env.NODE_ENV !== 'test' ? process.env.REDIS_URL : null;

let sharedStore;
let redisClient = null;

if (REDIS_URL) {
  try {
    redisClient = createClient({ url: REDIS_URL, disableOfflineQueue: true, socket: { connectTimeout: 1000 } });
    redisClient.on('error', (err) => {
      console.warn('[LimitForge Demo] Redis connection warning:', err.message);
    });
    redisClient.connect().catch((err) => {
      console.warn('[LimitForge Demo] Redis connection stopped:', err.message);
    });
    sharedStore = new ResilientStore({ primaryStore: new RedisStore({ client: redisClient }) });
  } catch (err) {
    console.warn('[LimitForge Demo] Redis initialization failed, using MemoryStore fallback:', err.message);
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
      store: req.rateLimit?.fallbackUsed ? 'memory' : (redisClient && redisClient.isReady ? 'redis' : 'memory'),
      clientIp: req.ip
    });
  }
);

router.get('/status', (req, res) => {
  res.json({
    status: 'online',
    package: 'limitforge',
    store: redisClient && redisClient.isReady ? 'redis' : 'memory',
    redisConnected: Boolean(redisClient && redisClient.isReady),
    clientIp: req.ip
  });
});

export async function closeRedisClient() {
  if (redisClient && redisClient.isOpen) {
    if (redisClient.isReady) await redisClient.quit().catch(() => {});
    else await redisClient.disconnect().catch(() => {});
  }
  redisClient = null;
  if (sharedStore instanceof ResilientStore) sharedStore.fallbackStore.destroy();
}

export default router;
