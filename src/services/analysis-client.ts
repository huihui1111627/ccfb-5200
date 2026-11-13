import { AnalyzeProgress, AnalyzeRequest } from '../workers/analysis.worker';
import { DetectionSettings, Recording } from '../types';
import { getFileBlob, putRecording } from '../db';

/**
 * Owns the analysis worker lifecycle. One worker at a time; callers receive
 * progress callbacks and can cancel by disposing the handle.
 */
export class AnalysisClient {
  private worker: Worker | null = null;

  async analyze(
    recording: Recording,
    opts: { settings?: DetectionSettings; detectOnly?: boolean },
    onProgress: (p: AnalyzeProgress) => void,
  ): Promise<void> {
    this.dispose();
    const blob = await getFileBlob(recording.id);
    if (!blob) throw new Error('录音文件缺失，可能已被清理');

    const worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;

    return new Promise<void>((resolve, reject) => {
      worker.onmessage = async (ev: MessageEvent<AnalyzeProgress>) => {
        const msg = ev.data;
        onProgress(msg);
        if (msg.kind === 'done') {
          this.dispose();
          resolve();
        } else if (msg.kind === 'error') {
          await putRecording({ ...recording, status: 'error', analyzeError: msg.message });
          this.dispose();
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (ev) => {
        this.dispose();
        reject(new Error(ev.message || 'worker 崩溃'));
      };
      const req: AnalyzeRequest = {
        type: 'analyze',
        recording,
        blob,
        settings: opts.settings,
        detectOnly: opts.detectOnly,
      };
      worker.postMessage(req);
    });
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
