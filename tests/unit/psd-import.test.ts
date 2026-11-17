// Unit tests for the PSD import (src/backend/psd-import.ts):
// real-file parsing against the committed fixture. The
// layers are no longer exploded into cards — a .psd lands
// as one FileCard whose preview is the file's merged
// composite — so only parsing is tested here.
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parsePsd } from "../../src/backend/psd-import";

const FIXTURE = new URL("../e2e/fixtures/sample.psd", import.meta.url);

// A Node Buffer's .buffer is a pooled ArrayBuffer: slice it
// to the file's own bytes before handing it to the parser.
function fixtureBytes(): ArrayBuffer {
  const bytes = readFileSync(FIXTURE);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("parsePsd (fixture)", () => {
  it("reads the fixture's size, layers, text and group", () => {
    const parsed = parsePsd(fixtureBytes());
    expect(parsed.width).toBe(200);
    expect(parsed.height).toBe(120);
    expect((parsed.children ?? []).map((l) => l.name)).toEqual(["Red square", "Title", "Group", "Hidden layer"]);
    const title = (parsed.children ?? [])[1];
    expect(title.text?.text).toBe("Hello PSD");
    expect(title.text?.style?.fontSize).toBe(24);
    expect(title.text?.style?.fillColor).toEqual({ r: 0, g: 0, b: 0 });
    expect((parsed.children ?? [])[3].hidden).toBe(true);
    const group = (parsed.children ?? [])[2];
    expect((group.children ?? []).map((l) => l.name)).toEqual(["Green square"]);
    const red = (parsed.children ?? [])[0];
    expect(red.imageData?.width).toBe(80);
    expect(red.imageData?.height).toBe(60);
    expect(red.imageData?.data[0]).toBe(255);
  });
  it("reads the fixture's merged composite", () => {
    const parsed = parsePsd(fixtureBytes());
    expect(parsed.imageData?.width).toBe(200);
    expect(parsed.imageData?.height).toBe(120);
  });
  it("throws on a file that is not a PSD", () => {
    expect(() => parsePsd(new TextEncoder().encode("not a psd file at all").buffer)).toThrow();
  });
});
