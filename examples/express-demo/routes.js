import { Router } from 'express';
import { rateLimiter } from '../../src/index.js';
import {
  testController,
  loginController,
  publicController
} from './controllers.js';

const router = Router();

/**
 * Route 1: GET /api/test
 * Policy: 5 requests per 60 seconds
 */
router.get(
  '/test',
  rateLimiter({
    limit: 5,
    windowMs: 60_000
  }),
  testController
);

// POST /api/login — Strict limit for auth/sensitive actions (3 req / 60s)
router.post(
  '/login',
  rateLimiter({
    limit: 3,
    windowMs: 60_000
  }),
  loginController
);

// GET /api/public — Standard public endpoint quota (10 req / 60s)
router.get(
  '/public',
  rateLimiter({
    limit: 10,
    windowMs: 60_000
  }),
  publicController
);

export default router;
