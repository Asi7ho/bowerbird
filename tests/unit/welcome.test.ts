// Unit tests for the welcome board (src/backend/welcome.ts):
// a pure function of (boardDir, pdfSize, videoSize), so these
// run in plain vitest on every push and PR.
import { describe, expect, it } from "vitest";
import { welcomeBoard } from "../../src/backend/welcome";

describe("welcomeBoard", () => {
  it("is deterministic for the same inputs", () => {
    expect(welcomeBoard("/b", 111, 222)).toEqual(welcomeBoard("/b", 111, 222));
  });

  it("shows every capability once, with sequential ids", () => {
    const board = welcomeBoard("/b", 111, 222);
    expect(board.items).toHaveLength(13);
    expect(board.items.map((it) => it.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(board.next_id).toBe(13);
    expect(board.next_group).toBe(2);
    const kinds = board.items.map((it) => Object.keys(it.kind)[0]);
    expect(kinds).toEqual([
      "Text", "Image", "UrlCard", "Swatch", "Swatch", "PdfCard",
      "Audio", "Video", "Text", "Swatch", "Text", "Stroke", "Connector",
    ]);
    const connector = board.items.find((it) => "Connector" in it.kind);
    expect((connector?.kind as { Connector: { from: { Item: number }; to: { Item: number } } }).Connector).toEqual({
      from: { Item: 2 },
      to: { Item: 3 },
      color: "#333333",
    });
  });

  it("references the board folder and the given sizes", () => {
    const board = welcomeBoard("/some/dir", 111, 222);
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
  });

  it("groups exactly the labelled pair", () => {
    const board = welcomeBoard("/b", 111, 222);
    const grouped = board.items.filter((it) => it.group === 1);
    expect(grouped).toHaveLength(2);
    expect(grouped.map((it) => Object.keys(it.kind)[0]).sort()).toEqual(["Swatch", "Text"]);
    expect(board.items.filter((it) => it.group !== null && it.group !== 1)).toHaveLength(0);
  });
});
