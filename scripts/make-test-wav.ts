import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SYNTH_SAMPLE_RATE, synthesize } from './synth';

export function writeWav16(path: string, samples: Float32Array, sampleRate: number): void {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
}

// CLI: tsx scripts/make-test-wav.ts [durationSec=600] [outDir=test-data]
if (import.meta.url === `file://${process.argv[1]}`) {
  const durationSec = Number(process.argv[2] ?? 600);
  const outDir = process.argv[3] ?? 'test-data';
  const { samples, groundTruth } = synthesize({
    durationSec,
    seed: 20260412,
    callsPerMinute: 3,
    includeWeather: true,
  });
  const stamp = '20260412_213000';
  const wavPath = `${outDir}/SITE07_${stamp}_synth${Math.round(durationSec)}s.wav`;
  writeWav16(wavPath, samples, SYNTH_SAMPLE_RATE);
  writeFileSync(`${wavPath}.groundtruth.json`, JSON.stringify(groundTruth, null, 2));
  console.log(`wrote ${wavPath} (${samples.length} samples, ${groundTruth.calls.length} calls)`);
  console.log(`wrote ${wavPath}.groundtruth.json`);
}
