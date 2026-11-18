// Unit tests for the welcome board (src/backend/welcome.ts):
// a pure function of (boardDir, pdfSize, videoSize, modelSize, psdSize, aiSize), so these
// run in plain vitest on every push and PR.
import { describe, expect, it } from "vitest";
import { welcomeBoard } from "../../src/backend/welcome";

describe("welcomeBoard", () => {
  it("is deterministic for the same inputs", () => {
    expect(welcomeBoard("/b", 111, 222, 333, 444, 555)).toEqual(welcomeBoard("/b", 111, 222, 333, 444, 555));
  });

  it("shows every capability once, with sequential ids", () => {
    const board = welcomeBoard("/b", 111, 222, 333, 444, 555);
    expect(board.items).toHaveLength(29);
    expect(board.items.map((it) => it.id)).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    expect(board.next_id).toBe(29);
    expect(board.next_group).toBe(2);
    const kinds = board.items.map((it) => Object.keys(it.kind)[0]);
    expect(kinds).toEqual([
      "Text", "Image", "UrlCard", "Swatch", "Swatch", "PdfCard",
      "Audio", "Video", "Text", "Swatch", "Text", "Stroke", "Connector",
      // Formats section: heading, then SVG, PSD, AI, 3D — a 2x2 grid.
      "Text",
      "Text",
      "Shape", "Shape", "Shape", "Stroke", "Stroke", "Stroke", "Text", "Shape",
      "Text",
      "FileCard",
      "Text",
      "FileCard",
      "Text",
      "Model3D",
    ]);
    const connector = board.items.find((it) => "Connector" in it.kind);
    expect((connector?.kind as { Connector: { from: { Item: number }; to: { Item: number } } }).Connector).toEqual({
      from: { Item: 2 },
      to: { Item: 3 },
      color: "#333333",
    });
  });

  it("references the board folder and the given sizes", () => {
    const board = welcomeBoard("/some/dir", 111, 222, 333, 444, 555);
    const image = board.items.find((it) => "Image" in it.kind);
    expect((image?.kind as { Image: { path: string } }).Image.path).toBe("/some/dir/welcome-bower.jpg");
    const pdf = board.items.find((it) => "PdfCard" in it.kind);
    expect((pdf?.kind as { PdfCard: { path: string; size_bytes: number } }).PdfCard).toEqual({
      path: "/some/dir/sample.pdf",
      size_bytes: 111,
    });
    const video = board.items.find((it) => "Video" in it.kind);
    expect((video?.kind as { Video: { source: string; remote: boolean; size_bytes: number } }).Video).toEqual({
      source: "/some/dir/welcome-video.mp4",
      remote: false,
      size_bytes: 222,
    });
    const model = board.items.find((it) => "Model3D" in it.kind);
    expect((model?.kind as { Model3D: { path: string; size_bytes: number } }).Model3D).toEqual({
      path: "/some/dir/welcome-cube.glb",
      size_bytes: 333,
    });
    const psd = board.items.find((it) => "FileCard" in it.kind && (it.kind as { FileCard: { format: string } }).FileCard.format === "psd");
    expect((psd?.kind as { FileCard: { path: string; size_bytes: number; format: string; preview?: string } }).FileCard).toEqual({
      path: "/some/dir/sample.psd",
      size_bytes: 444,
      format: "psd",
      preview: "/some/dir/welcome-psd-preview.png",
    });
    const ai = board.items.find((it) => "FileCard" in it.kind && (it.kind as { FileCard: { format: string } }).FileCard.format === "ai");
    expect((ai?.kind as { FileCard: { path: string; size_bytes: number; format: string; preview?: string } }).FileCard).toEqual({
      path: "/some/dir/sample.ai",
      size_bytes: 555,
      format: "ai",
      preview: "/some/dir/welcome-ai-preview.png",
    });
  });

  it("groups exactly the labelled pair", () => {
    const board = welcomeBoard("/b", 111, 222, 333, 444, 555);
    const grouped = board.items.filter((it) => it.group === 1);
    expect(grouped).toHaveLength(2);
    expect(grouped.map((it) => Object.keys(it.kind)[0]).sort()).toEqual(["Swatch", "Text"]);
    expect(board.items.filter((it) => it.group !== null && it.group !== 1)).toHaveLength(0);
  });
});
