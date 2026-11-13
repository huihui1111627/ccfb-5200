import { synthesize, SYNTH_SAMPLE_RATE } from '../../scripts/synth';
import { encodeWavBlob } from '../audio/wav-encode';
import { GroundTruth } from '../types';

export interface BrowserSynthOpts {
  durationSec: number;
  callsPerMinute: number;
  seed: number;
}

export interface BrowserSynthResult {
  file: File;
  groundTruth: GroundTruth;
}

/**
 * Build a synthetic WAV entirely in the browser. Shares the deterministic
 * generator with the Node self-test, so detector accuracy measured in Node
 * transfers directly to what the UI produces.
 */
export async function synthesizeInBrowser(opts: BrowserSynthOpts): Promise<BrowserSynthResult> {
  const { samples, groundTruth } = synthesize({
    durationSec: opts.durationSec,
    seed: opts.seed,
    callsPerMinute: opts.callsPerMinute,
    includeWeather: true,
  });
  const blob = encodeWavBlob(samples, 1, SYNTH_SAMPLE_RATE);
  const stamp = '20260412_213000';
  const file = new File(
    [blob],
    `SITE07_${stamp}_synth${Math.round(opts.durationSec)}s.wav`,
    { type: 'audio/wav' },
  );
  return { file, groundTruth };
}
