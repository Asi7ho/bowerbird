// Unit tests for the audio waveform peaks
// (src/backend/audio-peaks.ts): real peak values per bar,
// normalised to the loudest bar.
import { describe, expect, it } from "vitest";
import { peaksFromSamples } from "../../src/backend/audio-peaks";

describe("peaksFromSamples", () => {
  it("returns all zeros for empty samples", () => {
    expect(peaksFromSamples(new Float32Array(0), 4)).toEqual([0, 0, 0, 0]);
  });
  it("returns an empty array for zero bars", () => {
    expect(peaksFromSamples(new Float32Array([0.5, 0.5]), 0)).toEqual([]);
  });
  it("returns all zeros for silence", () => {
    expect(peaksFromSamples(new Float32Array(8), 4)).toEqual([0, 0, 0, 0]);
  });
  it("normalises a constant signal to all ones", () => {
    expect(peaksFromSamples(new Float32Array(8).fill(0.5), 4)).toEqual([1, 1, 1, 1]);
  });
  it("puts a single spike in its own bar", () => {
    const samples = new Float32Array(8);
    samples[1] = 0.8;
    expect(peaksFromSamples(samples, 4)).toEqual([1, 0, 0, 0]);
  });
  it("normalises bars relative to the loudest one", () => {
    // Four bars over eight samples: [0.2, 0.2] [0.4, 0.4]
    // [0.1, 0.1] [0.8, 0.8] -> [0.25, 0.5, 0.125, 1].
    const samples = new Float32Array([0.2, 0.2, 0.4, 0.4, 0.1, 0.1, 0.8, 0.8]);
    expect(peaksFromSamples(samples, 4)).toEqual([0.25, 0.5, 0.125, 1]);
  });
  it("handles more bars than samples without crashing", () => {
    const peaks = peaksFromSamples(new Float32Array([0.5]), 4);
    expect(peaks).toHaveLength(4);
    expect(peaks[0]).toBe(1);
  });
  it("uses the absolute value, so negative samples count", () => {
    const samples = new Float32Array([-0.6, 0.3]);
    expect(peaksFromSamples(samples, 1)).toEqual([1]);
  });
});
