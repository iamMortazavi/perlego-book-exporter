/**
 * @file Async concurrency, timing, and event-driven DOM waiting utilities.
 * Includes abortable sleep, frame-budget yielding, MutationObserver polling,
 * bounded worker pool (`mapPool`), and exponential backoff retries.
 */
(() => {
  'use strict';

  const PD = (globalThis.PerlegoDownloader = globalThis.PerlegoDownloader || {});

  /**
   * Sleep for `ms` milliseconds, optionally abortable via an AbortSignal.
   * @param {number} ms
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  function sleep(ms, signal) {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      function onAbort() {
        clearTimeout(timer);
        reject(createAbortError());
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  function createAbortError() {
    if (typeof DOMException !== 'undefined') {
      return new DOMException('Operation aborted', 'AbortError');
    }
    const err = new Error('Operation aborted');
    err.name = 'AbortError';
    return err;
  }

  /**
   * Creates a 50ms frame-budget yield controller using scheduler.yield() with setTimeout fallback.
   * @param {number} [budgetMs=50]
   * @returns {{ maybeYield: (signal?: AbortSignal) => Promise<void>, reset: () => void }}
   */
  function createYieldController(budgetMs = 50) {
    let deadline = performance.now() + budgetMs;

    async function maybeYield(signal) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      if (performance.now() < deadline) {
        return;
      }
      if (typeof globalThis.scheduler?.yield === 'function') {
        await globalThis.scheduler.yield();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (signal?.aborted) {
        throw createAbortError();
      }
      deadline = performance.now() + budgetMs;
    }

    function reset() {
      deadline = performance.now() + budgetMs;
    }

    return { maybeYield, reset };
  }

  /**
   * Waits for `checkFn()` to return a truthy value using MutationObserver + fallback polling.
   * Resolves immediately if already truthy, or with `null` on timeout.
   * @template T
   * @param {() => T} checkFn
   * @param {{ timeoutMs?: number, root?: Node|null, pollIntervalMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<T|null>}
   */
  function waitForCondition(checkFn, options = {}) {
    const {
      timeoutMs = 12000,
      root = typeof document !== 'undefined' ? document.body : null,
      pollIntervalMs = 100,
      signal,
    } = options;

    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    try {
      const immediate = checkFn();
      if (immediate) return Promise.resolve(immediate);
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let observer = null;
      let pollTimer = null;
      let timeoutTimer = null;

      function cleanup() {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      }

      function finish(value) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }

      function fail(err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      }

      function onAbort() {
        fail(createAbortError());
      }

      function evaluate() {
        if (settled) return;
        try {
          const result = checkFn();
          if (result) finish(result);
        } catch (err) {
          fail(err);
        }
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (typeof MutationObserver !== 'undefined' && root) {
        observer = new MutationObserver(evaluate);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'src', 'data-srcset', 'data', 'style'],
        });
      }

      pollTimer = setInterval(evaluate, pollIntervalMs);
      timeoutTimer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  /**
   * Executes `iteratee` over `items` with bounded concurrency while preserving order.
   * Supports optional AbortSignal cancellation.
   * @template T, R
   * @param {T[]} items
   * @param {number} concurrency
   * @param {(item: T, index: number) => Promise<R>} iteratee
   * @param {(completed: number, total: number) => void} [onProgress]
   * @param {AbortSignal} [signal]
   * @returns {Promise<R[]>}
   */
  async function mapPool(items, concurrency, iteratee, onProgress, signal) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (!Array.isArray(items) || items.length === 0) return [];
    const limit = Math.max(1, Math.min(concurrency || 6, items.length));
    const results = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
      while (true) {
        if (signal?.aborted) {
          throw createAbortError();
        }
        const current = nextIndex++;
        if (current >= items.length) return;
        results[current] = await iteratee(items[current], current);
        if (signal?.aborted) {
          throw createAbortError();
        }
        completed += 1;
        if (typeof onProgress === 'function') {
          onProgress(completed, items.length);
        }
      }
    }

    const workers = [];
    for (let i = 0; i < limit; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  /**
   * Retries an async operation with exponential backoff and jitter.
   * @template T
   * @param {(attempt: number) => Promise<T>} fn
   * @param {{ retries?: number, baseDelayMs?: number, maxDelayMs?: number, shouldRetry?: (err: unknown, attempt: number) => boolean, signal?: AbortSignal }} [options]
   * @returns {Promise<T>}
   */
  async function retryWithBackoff(fn, options = {}) {
    const {
      retries = 2,
      baseDelayMs = 250,
      maxDelayMs = 3000,
      shouldRetry = () => true,
      signal,
    } = options;

    let attempt = 0;
    while (true) {
      if (signal?.aborted) {
        throw createAbortError();
      }
      try {
        return await fn(attempt);
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) {
          throw err?.name === 'AbortError' ? err : createAbortError();
        }
        if (attempt >= retries || !shouldRetry(err, attempt)) {
          throw err;
        }
        const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        const jitter = Math.floor(Math.random() * Math.min(150, expDelay * 0.35));
        attempt += 1;
        await sleep(expDelay + jitter, signal);
      }
    }
  }

  PD.async = {
    sleep,
    createAbortError,
    createYieldController,
    waitForCondition,
    mapPool,
    retryWithBackoff,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PD.async;
  }
})();
