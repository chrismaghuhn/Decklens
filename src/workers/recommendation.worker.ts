/**
 * Recommendation Engine Web Worker
 * Runs the recommendation engine computation off the main thread.
 */

import {
  generateRecommendationEngineV1,
  type RecommendationEngineInput,
  type RecommendationEngineV1Response,
} from '../mtg/engine/recommendation-v1.js';

export interface RecWorkerRequest {
  type: 'generate-recommendations';
  payload: RecommendationEngineInput;
  id: string;
}

export interface RecWorkerResponse {
  type: 'recommendation-result';
  payload: RecommendationEngineV1Response;
  id: string;
}

export interface RecWorkerError {
  type: 'error';
  payload: { error: string };
  id: string;
}

self.onmessage = function(event: MessageEvent<RecWorkerRequest>) {
  const { type, payload, id } = event.data;

  if (type === 'generate-recommendations') {
    try {
      const result = generateRecommendationEngineV1(payload);
      const response: RecWorkerResponse = {
        type: 'recommendation-result',
        payload: result,
        id,
      };
      self.postMessage(response);
    } catch (error) {
      const errorResponse: RecWorkerError = {
        type: 'error',
        payload: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        id,
      };
      self.postMessage(errorResponse);
    }
  }
};

export {};
