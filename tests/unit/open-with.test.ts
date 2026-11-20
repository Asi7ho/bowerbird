import { describe, expect, it, vi } from "vitest";
import { editorCandidates, openBoardFile, type OpenTarget } from "../../electron/open-with";

const bundle = (id: string): OpenTarget => ({ via: "bundle", id });
const named = (name: string): OpenTarget => ({ via: "name", name });

describe("editorCandidates", () => {
  it("lists editors for .psd, bundle ids first, in order", () => {
    expect(editorCandidates(".psd")).toEqual([
      bundle("com.adobe.Photoshop"),
      named("Adobe Photoshop"),
      bundle("com.seriflabs.affinityphoto2"),
      named("Affinity Photo 2"),
      bundle("com.seriflabs.affinityphoto"),
      named("Affinity Photo"),
      named("Affinity"),
      bundle("com.pixelmatorteam.pixelmator"),
      named("Pixelmator Pro"),
      named("GIMP"),
    ]);
  });

  it("lists editors for .ai, in order", () => {
    expect(editorCandidates(".ai")).toEqual([
      bundle("com.adobe.Illustrator"),
      named("Adobe Illustrator"),
      bundle("com.seriflabs.affinitydesigner2"),
      named("Affinity Designer 2"),
      bundle("com.seriflabs.affinitydesigner"),
      named("Affinity Designer"),
      named("Affinity"),
      named("Inkscape"),
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
    expect(runOpen).toHaveBeenCalledWith(bundle("com.adobe.Photoshop"), file);
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
    expect(runOpen).toHaveBeenNthCalledWith(2, named("Adobe Photoshop"), file);
    expect(openDefault).not.toHaveBeenCalled();
  });

  it("falls back to the default app when no editor is installed", async () => {
    const runOpen = vi.fn().mockRejectedValue(new Error("Unable to find application"));
    const openDefault = vi.fn().mockResolvedValue("opened-by-default");
    const out = await openBoardFile(file, { platform: "darwin", runOpen, openDefault });
    expect(out).toBe("opened-by-default");
    expect(runOpen).toHaveBeenCalledTimes(10);
    expect(openDefault).toHaveBeenCalledTimes(1);
    expect(openDefault).toHaveBeenCalledWith(file);
  });

  it("matches the extension case-insensitively", async () => {
    const runOpen = vi.fn().mockResolvedValue(undefined);
    const openDefault = vi.fn();
    await openBoardFile("/boards/main/File.PSD", { platform: "darwin", runOpen, openDefault });
    expect(runOpen).toHaveBeenCalledWith(bundle("com.adobe.Photoshop"), "/boards/main/File.PSD");
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
