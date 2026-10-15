import type { Request, Response, NextFunction, RequestHandler } from 'express';

export type RateLimiterAlgorithm = 'fixed-window' | 'sliding-window' | 'token-bucket';
export type FailStrategy = 'fail-open' | 'fail-closed';

export interface StoreConsumeParams {
  key: string;
  limit?: number;
  windowMs?: number;
  algorithm?: RateLimiterAlgorithm;
  capacity?: number;
  refillRate?: number;
  refillIntervalMs?: number;
  cost?: number;
  now?: number;
}

export interface StoreConsumeResult {
  allowed: boolean;
  count?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
  degraded?: boolean;
  circuitState?: string;
}

export interface IRateLimitStore {
  consume(params: StoreConsumeParams): Promise<StoreConsumeResult> | StoreConsumeResult;
  resetKey?(key: string): Promise<void> | void;
  destroy?(): void;
}

export interface RateLimiterOptions {
  limit?: number | ((req: Request) => number | Promise<number>);
  windowMs?: number | ((req: Request) => number | Promise<number>);
  store?: IRateLimitStore;
  fallbackStore?: boolean | IRateLimitStore;
  algorithm?: RateLimiterAlgorithm;
  capacity?: number | ((req: Request) => number | Promise<number>);
  refillRate?: number | ((req: Request) => number | Promise<number>);
  refillIntervalMs?: number;
  cost?: number | ((req: Request) => number | Promise<number>);
  keyGenerator?: (req: Request) => string | Promise<string>;
  hashClientIdentifier?: boolean | ((identifier: string) => string);
  timeoutMs?: number;
  failureThreshold?: number;
  resetTimeoutMs?: number;
  failStrategy?: FailStrategy;
  metrics?: boolean | MetricsCollector;
  openTelemetry?: boolean | { tracer?: any; getSpan?: (req: Request) => any };
  onStoreError?: (err: Error, req: Request, res: Response, next: NextFunction) => void;
  statusCode?: number;
  message?: string | object | ((req: Request, res: Response) => any);
  skip?: (req: Request) => boolean | Promise<boolean>;
  skipFailedRequests?: boolean;
  skipSuccessfulRequests?: boolean;
}

export declare function rateLimiter(options?: RateLimiterOptions): RequestHandler;
export default rateLimiter;

export declare class MemoryStore implements IRateLimitStore {
  constructor(options?: { cleanupIntervalMs?: number });
  consume(params: StoreConsumeParams): StoreConsumeResult;
  resetKey(key: string): void;
  destroy(): void;
}

export interface RedisClientLike {
  eval(script: string, options: { keys: string[]; arguments: (string | number)[] }): Promise<any>;
  sendCommand?(args: string[]): Promise<any>;
}

export declare class RedisStore implements IRateLimitStore {
  constructor(options: { client: RedisClientLike; prefix?: string });
  consume(params: StoreConsumeParams): Promise<StoreConsumeResult>;
  resetKey(key: string): Promise<void>;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  name?: string;
  breakerId?: string;
  onStateChange?: (oldState: string, newState: string) => void;
}

export declare class CircuitBreaker {
  constructor(options?: CircuitBreakerOptions);
  execute<T>(action: () => Promise<T>): Promise<T>;
  getState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  trip(): void;
  reset(): void;
}

export declare class ResilientStore implements IRateLimitStore {
  primaryStore: IRateLimitStore;
  fallbackStore: IRateLimitStore;
  breaker: CircuitBreaker;
  constructor(options: {
    primaryStore: IRateLimitStore;
    fallbackStore?: IRateLimitStore;
    breaker?: CircuitBreaker;
    timeoutMs?: number;
    failureThreshold?: number;
    resetTimeoutMs?: number;
    breakerId?: string;
  });
  consume(params: StoreConsumeParams): Promise<StoreConsumeResult>;
  resetKey(key: string): Promise<void>;
  getStats(): {
    circuitBreaker: { state: string; failureCount: number };
    primaryStore: string;
    fallbackStore: string;
  };
}

export declare class MetricsCollector {
  constructor(options?: { maxSeries?: number; metricMap?: Map<string, any> });
  recordRequest(params: {
    outcome: 'allowed' | 'blocked';
    normalized_route?: string;
    method?: string;
    status_code?: number;
    store?: string;
    degraded?: boolean;
  }): void;
  recordStoreDuration(params: {
    store: string;
    operation: string;
    outcome: 'success' | 'failure' | 'timeout';
    duration_ms: number;
  }): void;
  recordCircuitBreakerState(params: {
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    breaker?: string;
  }): void;
  getSnapshot(): any;
  reset(): void;
}

export declare const defaultMetricsCollector: MetricsCollector;

export declare class OpenTelemetryBridge {
  constructor(options?: { tracer?: any; getSpan?: (req: Request) => any });
  startSpan(name?: string, options?: any): any;
  resolveSpan(req: Request): any;
  recordEvaluation(params: {
    req: Request;
    result: StoreConsumeResult;
    algorithm?: string;
    normalizedRoute?: string;
    store?: string;
  }): void;
  recordStoreError(params: { req: Request; storeError: Error; store?: string }): void;
}

export declare class StoreTimeoutError extends Error {
  code: string;
  timeoutMs: number;
  constructor(timeoutMs: number, operation?: string);
}

export declare class CircuitBreakerOpenError extends Error {
  code: string;
  retryAfter: number;
  constructor(message?: string, retryAfter?: number);
}

export declare const MAX_IDENTIFIER_LENGTH: number;

export declare function buildRateLimitKey(params: {
  method?: string;
  route?: string;
  clientIdentifier?: string;
  algorithm?: string;
  prefix?: string;
  hashClientIdentifier?: boolean | ((id: string) => string);
}): string;

export declare function normalizeRoute(path: string): string;
export declare function sanitizePath(path: string): string;
export declare function createPrometheusExporter(collector?: MetricsCollector): RequestHandler;
export declare function formatPrometheusMetrics(snapshot: any): string;
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation?: string): Promise<T>;
export declare function runBenchmark(options?: any): Promise<any>;
export declare function calculatePercentiles(latencies: bigint[]): any;

export declare const METRIC_NAMES: Record<string, string>;
export declare const METRIC_TYPE: Record<string, string>;
export declare const CIRCUIT_STATE: Record<string, string>;
