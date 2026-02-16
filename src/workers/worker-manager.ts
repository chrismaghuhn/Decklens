/**
 * Web Worker Manager
 * Manages web workers for performance-critical operations
 */

import type { ArchetypeId } from '../mtg/engine/archetype-catalog.js';
import type { Deck } from '../shared/types.js';

export interface ArchetypeDetectionWorkerResult {
  primaryArchetype: ArchetypeId | null;
  secondaryArchetypes: Array<{ id: ArchetypeId; confidence: number }>;
  allScores: Array<{ id: ArchetypeId; score: number; confidence: number }>;
  detectedCards: Partial<Record<ArchetypeId, string[]>>;
  counterCards: string[];
  hybridArchetype: boolean;
}

export interface WorkerTask<TInput, TOutput> {
  id: string;
  input: TInput;
  resolve: (value: TOutput) => void;
  reject: (reason: Error) => void;
  timestamp: number;
}

export class WorkerManager {
  private archetypeWorker: Worker | null = null;
  private pendingTasks: Map<string, WorkerTask<unknown, unknown>> = new Map();
  private taskId = 0;
  private workerUrl: string;

  constructor() {
    // Create worker URL from the worker file
    this.workerUrl = new URL('./archetype-detector.worker.ts', import.meta.url).href;
    this.initArchetypeWorker();
  }

  /**
   * Initialize the archetype detection worker
   */
  private initArchetypeWorker(): void {
    try {
      this.archetypeWorker = new Worker(this.workerUrl, { type: 'module' });
      
      this.archetypeWorker.onmessage = (event) => {
        const { type, payload, id } = event.data;
        const task = this.pendingTasks.get(id);
        
        if (!task) return;
        
        if (type === 'archetype-detection-result') {
          task.resolve(payload as ArchetypeDetectionWorkerResult);
        } else if (type === 'error') {
          task.reject(new Error(payload.error));
        }
        
        this.pendingTasks.delete(id);
      };

      this.archetypeWorker.onerror = (error) => {
        console.error('Worker error:', error);
        // Reject all pending tasks
        for (const [id, task] of this.pendingTasks) {
          task.reject(new Error('Worker failed'));
        }
        this.pendingTasks.clear();
      };
    } catch (error) {
      console.warn('Failed to initialize web worker:', error);
      this.archetypeWorker = null;
    }
  }

  /**
   * Detect archetypes using web worker
   */
  async detectArchetypes(
    deck: Deck,
    cardData: Record<string, { name: string; type_line?: string; oracle_text?: string; color_identity?: string[] }>
  ): Promise<ArchetypeDetectionWorkerResult> {
    // If worker is not available, fall back to main thread
    if (!this.archetypeWorker) {
      console.log('[WorkerManager] Worker not available, using main thread fallback');
      return this.fallbackDetectArchetypes(deck, cardData);
    }

    const id = this.generateTaskId();
    
    return new Promise((resolve, reject) => {
      const task: WorkerTask<unknown, unknown> = {
        id,
        input: { deck, cardData },
        resolve: resolve as (value: unknown) => void,
        reject,
        timestamp: Date.now(),
      };
      
      this.pendingTasks.set(id, task);
      
      // Send message to worker
      this.archetypeWorker!.postMessage({
        type: 'detect-archetypes',
        payload: { deck, cardData },
        id,
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingTasks.has(id)) {
          this.pendingTasks.delete(id);
          reject(new Error('Worker timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Fallback detection when worker is not available
   */
  private async fallbackDetectArchetypes(
    deck: Deck,
    cardData: Record<string, { name: string; type_line?: string; oracle_text?: string }>
  ): Promise<ArchetypeDetectionWorkerResult> {
    // Import and use the main thread detector
    const { detectDeckArchetype } = await import('../mtg/engine/archetype-detector.js');
    
    const result = detectDeckArchetype(
      deck,
      (cardName) => {
        const card = cardData[cardName.toLowerCase()];
        return card ? {
          name: card.name,
          type_line: card.type_line,
          oracle_text: card.oracle_text,
        } : undefined;
      }
    );

    // Convert to worker result format
    return {
      primaryArchetype: result.primaryArchetype,
      secondaryArchetypes: result.secondaryArchetypes,
      allScores: result.allScores,
      detectedCards: Object.fromEntries(result.detectedCards) as Partial<Record<ArchetypeId, string[]>>,
      counterCards: result.counterCards,
      hybridArchetype: result.hybridArchetype,
    };
  }

  /**
   * Terminate all workers
   */
  terminate(): void {
    if (this.archetypeWorker) {
      this.archetypeWorker.terminate();
      this.archetypeWorker = null;
    }
    
    // Reject all pending tasks
    for (const [id, task] of this.pendingTasks) {
      task.reject(new Error('Worker terminated'));
    }
    this.pendingTasks.clear();
  }

  /**
   * Get pending task count
   */
  getPendingTaskCount(): number {
    return this.pendingTasks.size;
  }

  /**
   * Check if worker is available
   */
  isWorkerAvailable(): boolean {
    return this.archetypeWorker !== null;
  }

  /**
   * Generate unique task ID
   */
  private generateTaskId(): string {
    return `task_${++this.taskId}_${Date.now()}`;
  }
}

// Singleton instance
let workerManagerInstance: WorkerManager | null = null;

export function getWorkerManager(): WorkerManager {
  if (!workerManagerInstance) {
    workerManagerInstance = new WorkerManager();
  }
  return workerManagerInstance;
}

export function resetWorkerManager(): void {
  if (workerManagerInstance) {
    workerManagerInstance.terminate();
    workerManagerInstance = null;
  }
}
