/**
 * E1: Recommendation Engine Web Worker Client
 * Wraps the recommendation worker with promise-based API and automatic fallback.
 */

import type { RecommendationEngineInput, RecommendationEngineV1Response } from '../mtg/engine/recommendation-v1.js';
import type { RecWorkerRequest, RecWorkerResponse, RecWorkerError } from '../workers/recommendation.worker.js';

let worker: Worker | null = null;
let requestCounter = 0;
const pendingRequests = new Map<string, {
  resolve: (value: RecommendationEngineV1Response) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(
      new URL('../workers/recommendation.worker.ts', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = (event: MessageEvent<RecWorkerResponse | RecWorkerError>) => {
      const msg = event.data;
      const pending = pendingRequests.get(msg.id);
      if (!pending) return;
      pendingRequests.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.type === 'recommendation-result') {
        pending.resolve(msg.payload);
      } else if (msg.type === 'error') {
        pending.reject(new Error(msg.payload.error));
      }
    };
    worker.onerror = () => {
      // If worker fails to load, null it out so we fall back to main thread
      terminateWorker();
    };
    return worker;
  } catch {
    return null;
  }
}

export function terminateWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  // Reject all pending
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Worker terminated'));
  }
  pendingRequests.clear();
}

/**
 * Run the recommendation engine in a Web Worker.
 * Falls back to null if the worker is unavailable (caller should use main-thread fallback).
 * Times out after 10 seconds.
 */
export function generateRecsViaWorker(
  input: RecommendationEngineInput,
  timeoutMs = 10000,
): Promise<RecommendationEngineV1Response> | null {
  const w = getWorker();
  if (!w) return null;

  const id = `rec-${++requestCounter}`;
  const request: RecWorkerRequest = {
    type: 'generate-recommendations',
    payload: input,
    id,
  };

  return new Promise<RecommendationEngineV1Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Recommendation worker timed out'));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });
    w.postMessage(request);
  });
}
