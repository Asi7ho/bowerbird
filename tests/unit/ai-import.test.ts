// Unit tests for the Illustrator PDF-compatibility check
// (src/backend/ai-import.ts).
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { isPdfCompatible } from "../../src/backend/ai-import";

const PDF_AI = new URL("../e2e/fixtures/sample.ai", import.meta.url);
const LEGACY_AI = new URL("../e2e/fixtures/legacy.ai", import.meta.url);

describe("isPdfCompatible", () => {
  it("accepts a PDF-compatible .ai file (a PDF under the hood)", () => {
    expect(isPdfCompatible(new Uint8Array(readFileSync(PDF_AI)))).toBe(true);
  });
  it("rejects a PostScript .ai file saved without PDF compatibility", () => {
    expect(isPdfCompatible(new Uint8Array(readFileSync(LEGACY_AI)))).toBe(false);
  });
  it.each([
    [new Uint8Array(0), "empty input"],
    [new TextEncoder().encode("%PDF"), "a bare %PDF prefix"],
    [new TextEncoder().encode("%PDX-1.4"), "a near-miss prefix"],
  ])("rejects %s", (input) => {
    expect(isPdfCompatible(input)).toBe(false);
  });
});
