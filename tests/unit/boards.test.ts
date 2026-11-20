// Unit tests for group labels (src/boards.ts): groups are
// groups, not sections — a group is labelled "Group N".
// boards.ts pulls in the app API (window.bowerbird) at
// load, so stub a window before importing it: the tests
// only exercise syncGroupLabels, which is pure.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Board, Item } from "bowerbird-plugin-api";

let syncGroupLabels: (b: Board) => void;

beforeAll(async () => {
  vi.stubGlobal("window", {});
  ({ syncGroupLabels } = await import("../../src/boards"));
});

function textItem(id: number, group: number | null): Item {
  return {
    id,
    pos: { x: 0, y: 0 },
    size: { w: 100, h: 50 },
    group,
    kind: { Text: { text: "a", bold: false, size: 16, color: "#000000" } },
  };
}

function board(items: Item[], groups?: Board["groups"]): Board {
  return {
    items,
    camera: { x: 0, y: 0, zoom: 1 },
    next_id: items.length + 1,
    next_group: 1,
    groups,
    bg: "#ffffff",
    grid: "Dots",
  };
}

describe("syncGroupLabels", () => {
  it("labels a new group 'Group N', not 'Section N'", () => {
    const b = board([textItem(1, 1), textItem(2, 1)]);
    syncGroupLabels(b);
    expect(b.groups?.[1]?.label).toBe("Group 1");
  });

  it("renames an old 'Section N' label to 'Group N'", () => {
    const b = board([textItem(1, 1), textItem(2, 1)], { 1: { label: "Section 1" } });
    syncGroupLabels(b);
    expect(b.groups?.[1]?.label).toBe("Group 1");
  });

  it("leaves a custom label alone", () => {
    const b = board([textItem(1, 1), textItem(2, 1)], { 1: { label: "Reading" } });
    syncGroupLabels(b);
    expect(b.groups?.[1]?.label).toBe("Reading");
  });
});
