// Unit tests for the board search engine (src/backend/search.ts):
// a board can carry two items with the same id (an external
// edit can reuse one), and MiniSearch throws on a duplicate
// document id — the search must survive that instead of dying
// silently with an empty count. The engine touches window at
// import time (api = window.bowerbird), so the bridge is stubbed
// and the module is imported fresh per test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../../src/backend/model";

function textItem(id: number, text: string) {
  return {
    id,
    pos: { x: 0, y: 0 },
    size: { w: 320, h: 80 },
    group: null,
    kind: { Text: { text, bold: false, size: 16, color: "#1A1A1A" } },
  };
}

describe("createBoardSearch", () => {
  let board: Board;
  let input: { value: string; addEventListener: () => void };
  let count: { textContent: string };
  let search: import("../../src/backend/search").BoardSearch;

  beforeEach(async () => {
    vi.resetModules();
    board = {
      items: [
        // Two cards sharing id 8, as an external board edit
        // once produced; plus the card the query should find.
        textItem(8, "Apple pie"),
        textItem(8, "Banana bread"),
        textItem(9, "Zebra crossing"),
      ],
      camera: { x: 0, y: 0, zoom: 1 },
      next_id: 10,
      next_group: 0,
      bg: "#FFFFFF",
      grid: "Dots",
    };
    vi.stubGlobal("window", {
      bowerbird: {
        contextIndexLoad: async () => ({}),
        contextIndexSave: async () => undefined,
      },
      // The engine registers a beforeunload flush on creation.
      addEventListener: () => {},
    });
    input = { value: "", addEventListener: () => {} };
    count = { textContent: "" };
    const mod = await import("../../src/backend/search");
    search = mod.createBoardSearch({
      getBoard: () => board,
      getBoardGeneration: () => 1,
      getBoardSearchVersion: () => 1,
      media: {
        indexPdfForSearch: () => {},
        pdfSearchText: new Map(),
      } as unknown as import("../../src/backend/media").Media,
      getCardsEl: () => ({ children: [] }) as unknown as HTMLDivElement,
      onJumpTo: () => {},
    });
    search.setSearchElements({
      input: input as unknown as HTMLInputElement,
      count: count as unknown as HTMLElement,
      clear: { style: {}, addEventListener: () => {} } as unknown as HTMLButtonElement,
      results: {
        style: {},
        innerHTML: "",
        addEventListener: () => {},
        querySelector: () => null,
      } as unknown as HTMLElement,
    });
  });

  it("still finds a match when two cards share an id", async () => {
    input.value = "Zebra";
    expect(() => search.updateSearch()).not.toThrow();
    // The async context part runs after; let it settle so a
    // rejection there would surface instead of leaking.
    await new Promise((r) => setTimeout(r, 50));
    expect(count.textContent.startsWith("1 match")).toBe(true);
  });

});
