import { StoreTimeoutError } from './errors.js';

export async function withTimeout(operation, timeoutMs) {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `SmartRate: 'timeoutMs' must be a positive number in milliseconds (received: ${timeoutMs}).`
    );
  }

  if (!operation || typeof operation.then !== 'function') {
    return operation;
  }

  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(new StoreTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    clearTimeout(timerId);
  }
}
