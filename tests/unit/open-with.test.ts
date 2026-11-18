import { describe, expect, it, vi } from "vitest";
import { editorCandidates, openBoardFile } from "../../electron/open-with";

describe("editorCandidates", () => {
  it("lists editors for .psd, in order", () => {
    expect(editorCandidates(".psd")).toEqual([
      "Adobe Photoshop",
      "Photoshop",
      "Affinity Photo",
      "Pixelmator Pro",
      "GIMP",
    ]);
  });

  it("lists editors for .ai, in order", () => {
    expect(editorCandidates(".ai")).toEqual([
      "Adobe Illustrator",
      "Illustrator",
      "Affinity Designer",
      "Inkscape",
    ]);
  });

  it("has no editors for other formats", () => {
    expect(editorCandidates(".png")).toEqual([]);
    expect(editorCandidates(".pdf")).toEqual([]);
    expect(editorCandidates("")).toEqual([]);
  });
});

describe("openBoardFile", () => {
  const file = "/boards/main/welcome-garden.psd";

  it("opens a .psd with the first installed editor and skips the default", async () => {
    const runOpen = vi.fn().mockResolvedValue(undefined);
    const openDefault = vi.fn().mockResolvedValue("default-called");
    const out = await openBoardFile(file, { platform: "darwin", runOpen, openDefault });
    expect(out).toBe("");
    expect(runOpen).toHaveBeenCalledTimes(1);
    expect(runOpen).toHaveBeenCalledWith("Adobe Photoshop", file);
    expect(openDefault).not.toHaveBeenCalled();
  });

  it("tries the next editor when the first one is not installed", async () => {
    const runOpen = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unable to find application"))
      .mockResolvedValue(undefined);
    const openDefault = vi.fn().mockResolvedValue("");
    await openBoardFile(file, { platform: "darwin", runOpen, openDefault });
    expect(runOpen).toHaveBeenCalledTimes(2);
    expect(runOpen).toHaveBeenNthCalledWith(2, "Photoshop", file);
    expect(openDefault).not.toHaveBeenCalled();
  });

  it("falls back to the default app when no editor is installed", async () => {
    const runOpen = vi.fn().mockRejectedValue(new Error("Unable to find application"));
    const openDefault = vi.fn().mockResolvedValue("opened-by-default");
    const out = await openBoardFile(file, { platform: "darwin", runOpen, openDefault });
    expect(out).toBe("opened-by-default");
    expect(runOpen).toHaveBeenCalledTimes(5);
    expect(openDefault).toHaveBeenCalledTimes(1);
    expect(openDefault).toHaveBeenCalledWith(file);
  });

  it("matches the extension case-insensitively", async () => {
    const runOpen = vi.fn().mockResolvedValue(undefined);
    const openDefault = vi.fn();
    await openBoardFile("/boards/main/File.PSD", { platform: "darwin", runOpen, openDefault });
    expect(runOpen).toHaveBeenCalledWith("Adobe Photoshop", "/boards/main/File.PSD");
  });

  it("uses the default directly on other platforms", async () => {
    const runOpen = vi.fn();
    const openDefault = vi.fn().mockResolvedValue("");
    await openBoardFile(file, { platform: "linux", runOpen, openDefault });
    expect(runOpen).not.toHaveBeenCalled();
    expect(openDefault).toHaveBeenCalledWith(file);
  });

  it("uses the default directly for formats with no editor", async () => {
    const runOpen = vi.fn();
    const openDefault = vi.fn().mockResolvedValue("");
    await openBoardFile("/boards/main/sample.pdf", { platform: "darwin", runOpen, openDefault });
    expect(runOpen).not.toHaveBeenCalled();
    expect(openDefault).toHaveBeenCalledWith("/boards/main/sample.pdf");
  });
});
