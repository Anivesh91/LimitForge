import type { Request, Response, NextFunction, RequestHandler } from 'express';

export type RateLimiterAlgorithm = 'fixed-window' | 'sliding-window' | 'token-bucket';
export type FailStrategy = 'fail-open' | 'fail-closed';
export type StoreErrorMode = 'fail-open' | 'fail-closed' | 'error';

export interface StoreConsumeParams {
  key: string;
  limit?: number;
  windowMs?: number;
  algorithm?: RateLimiterAlgorithm;
  capacity?: number;
  refillRate?: number;
  refillIntervalMs?: number;
  cost?: number;
  /** RedisStore uses server time by default. An explicit override requires a shared clock. */
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
  store?: string;
  fallbackUsed?: boolean;
}

export interface IRateLimitStore {
  consume(params: StoreConsumeParams): Promise<StoreConsumeResult> | StoreConsumeResult;
  cleanupExpiredRecords?(now?: number): number | Promise<number>;
  resetKey?(key: string): Promise<void> | void;
  destroy?(): void;
  prefix?: string;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  successThreshold?: number;
  name?: string;
  id?: string;
  breakerId?: string;
  isFailure?: (err: Error) => boolean;
}

export declare class CircuitBreaker {
  failureThreshold: number;
  resetTimeoutMs: number;
  successThreshold: number;
  id: string | null;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  constructor(options?: CircuitBreakerOptions);
  execute<T>(action: () => Promise<T>): Promise<T>;
  getState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  trip(): void;
  reset(): void;
  getStats(): {
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    failureThreshold: number;
    resetTimeoutMs: number;
    successThreshold: number;
    lastFailureTime: number | null;
    nextAttempt: number;
    probeInFlight: boolean;
  };
}

export interface RateLimiterOptions {
  limit?: number | ((req: Request) => number | Promise<number>);
  windowMs?: number | ((req: Request) => number | Promise<number>);
  store?: IRateLimitStore;
  fallbackStore?: boolean | IRateLimitStore;
  algorithm?: RateLimiterAlgorithm;
  capacity?: number | ((req: Request) => number | Promise<number>);
  refillRate?: number | ((req: Request) => number | Promise<number>);
  refillIntervalMs?: number | ((req: Request) => number | Promise<number>);
  cost?: number | ((req: Request) => number | Promise<number>);
  keyGenerator?: (req: Request) => string | undefined | null | Promise<string | undefined | null>;
  hashClientIdentifier?: boolean | ((identifier: string) => string);
  prefix?: string;
  timeoutMs?: number;
  circuitBreaker?: boolean | CircuitBreakerOptions | CircuitBreaker;
  failureThreshold?: number;
  resetTimeoutMs?: number;
  successThreshold?: number;
  breakerId?: string;
  failStrategy?: FailStrategy;
  onStoreError?: StoreErrorMode | ((err: Error, req: Request, res: Response, next: NextFunction) => void);
  metrics?: boolean | MetricsCollectorInput;
  metricsCollector?: MetricsCollectorInput;
  routeNormalizer?: (req: Request) => string;
  includeRoute?: boolean;
  openTelemetry?: boolean | OpenTelemetryBridge | { tracer?: any; getSpan?: (req: Request) => any; recordEvaluation?: Function; recordStoreError?: Function };
  statusCode?: number;
  standardHeaders?: boolean;
  message?: string | object | ((req: Request, res: Response) => any | Promise<any>);
  skip?: (req: Request) => boolean | Promise<boolean>;
}

export declare function rateLimiter(options?: RateLimiterOptions): RequestHandler;
export default rateLimiter;

export declare class MemoryStore implements IRateLimitStore {
  cleanupIntervalMs: number;
  store: Map<string, any>;
  constructor(options?: { cleanupIntervalMs?: number });
  consume(params: StoreConsumeParams): StoreConsumeResult;
  cleanupExpiredRecords(now?: number): number;
  destroy(): void;
}

export interface RedisClientLike {
  eval(script: string, options: { keys: string[]; arguments: (string | number)[] }): Promise<any>;
  sendCommand?(args: string[]): Promise<any>;
}

export declare class RedisStore implements IRateLimitStore {
  client: RedisClientLike;
  prefix?: string;
  constructor(options: { client: RedisClientLike; prefix?: string });
  consume(params: StoreConsumeParams): Promise<StoreConsumeResult>;
}

export interface ResilientStoreOptions {
  primaryStore: IRateLimitStore;
  fallbackStore?: IRateLimitStore;
  circuitBreaker?: boolean | CircuitBreakerOptions | CircuitBreaker;
  breaker?: CircuitBreaker;
  timeoutMs?: number;
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export declare class ResilientStore implements IRateLimitStore {
  primaryStore: IRateLimitStore;
  fallbackStore: IRateLimitStore;
  circuitBreaker: CircuitBreaker | null;
  readonly breaker: CircuitBreaker | null;
  timeoutMs: number;
  constructor(options: ResilientStoreOptions);
  consume(params: StoreConsumeParams): Promise<StoreConsumeResult>;
  cleanupExpiredRecords(now?: number): number;
  getStats(): {
    circuitBreaker: any;
    timeoutMs: number;
    hasFallbackStore: boolean;
  };
}

export declare class MetricsCollector {
  constructor(options?: {
    maxSeries?: number;
    storeDurationBuckets?: readonly number[];
    /** @deprecated This option is ignored by the runtime. */
    metricMap?: Map<string, any>;
  });
  incrementCounter(name: string, labels?: Record<string, unknown>, value?: number): void;
  setGauge(name: string, value: number, labels?: Record<string, unknown>): void;
  observeHistogram(name: string, durationSeconds: number, labels?: Record<string, unknown>, customBuckets?: readonly number[]): void;
  recordRequest(params: {
    outcome?: string;
    algorithm?: string;
    normalized_route?: string;
    method?: string;
    /** @deprecated This field is ignored by the runtime. */
    status_code?: number;
    store?: string;
    /** @deprecated This field is ignored by the runtime. */
    degraded?: boolean;
  }): void;
  recordStoreError(params: { store?: string; error_type?: string }): void;
  recordDegradedRequest(params: { reason?: string }): void;
  recordStoreDuration(durationSeconds: number, labels?: Record<string, unknown>): void;
  /** Unknown state strings are recorded as CLOSED. */
  recordCircuitBreakerState(state: string, labels?: Record<string, unknown>): void;
  getSnapshot(): any;
  reset(): void;
}

/** Collector shape accepted by limiter options before additional methods were declared. */
export type MetricsCollectorInput = Pick<MetricsCollector,
  'recordRequest' | 'recordStoreDuration' | 'recordCircuitBreakerState' | 'getSnapshot' | 'reset'>;

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
  isTimeout: boolean;
  timeoutMs: number;
  constructor(timeoutMs?: number, message?: string);
}

export declare class CircuitBreakerOpenError extends Error {
  code: string;
  isCircuitOpen: boolean;
  resetTimeoutMs?: number;
  constructor(message?: string, resetTimeoutMs?: number);
}

export declare const MAX_IDENTIFIER_LENGTH: number;

export declare function buildRateLimitKey(params?: {
  method?: string;
  route?: string;
  clientIdentifier?: string;
  algorithm?: string;
  prefix?: string;
  hashClientIdentifier?: boolean | ((id: string) => string);
}): string;

export declare function normalizeRoute(req: Request, customNormalizer?: (req: Request) => string): string;
export declare function sanitizePath(rawPath: string): string;
export interface PrometheusCollector {
  getSnapshot(): any;
}
export interface PrometheusExporterOptions {
  collector?: PrometheusCollector;
  metricsCollector?: PrometheusCollector;
}
export declare function createPrometheusExporter(options?: PrometheusCollector | PrometheusExporterOptions): RequestHandler;
export declare function formatPrometheusMetrics(snapshot?: any): string;
export declare function escapeLabelValue(value: unknown): string;
export declare function escapeHelpString(help: unknown): string;
export declare function formatLabels(labels?: Record<string, unknown>, additionalLabels?: Record<string, unknown>): string;
export declare function withTimeout<T>(operation: Promise<T> | T, timeoutMs: number): Promise<T>;
export declare function runBenchmark(options?: any): Promise<any>;
export declare function calculatePercentiles(latencies: bigint[]): any;

export declare const METRIC_NAMES: Record<string, string>;
export declare const METRIC_TYPE: Record<string, string>;
export declare const METRIC_METADATA: Readonly<Record<string, { type: string; help: string }>>;
export declare const CIRCUIT_STATE: Record<string, string>;
export declare const CIRCUIT_STATE_GAUGE_VALUES: Readonly<Record<'CLOSED' | 'HALF_OPEN' | 'OPEN', number>>;
export declare const DEFAULT_STORE_DURATION_BUCKETS: readonly number[];
