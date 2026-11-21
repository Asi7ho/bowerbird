// Waveform peaks for an audio card: one value per bar, the
// loudest sample in that slice of the (mono) audio,
// normalised so the loudest bar is 1. Pure: the decode and
// the fetch live in media.ts, so this is unit-testable
// without an AudioContext.
export function peaksFromSamples(samples: Float32Array, bars: number): number[] {
  if (bars <= 0) return [];
  const out: number[] = new Array<number>(bars).fill(0);
  if (samples.length === 0) return out;
  const per = samples.length / bars;
  let max = 0;
  for (let i = 0; i < bars; i++) {
    const start = Math.floor(i * per);
    const end = Math.max(start + 1, Math.floor((i + 1) * per));
    let peak = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
    if (peak > max) max = peak;
  }
  if (max <= 0) return out;
  return out.map((v) => v / max);
}
