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
  it("rejects empty and garbage input", () => {
    expect(isPdfCompatible(new Uint8Array(0))).toBe(false);
    expect(isPdfCompatible(new TextEncoder().encode("%PDF"))).toBe(false);
    expect(isPdfCompatible(new TextEncoder().encode("%PDX-1.4"))).toBe(false);
  });
});
