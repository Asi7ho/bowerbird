// Unit tests for the DOM-node card renderer path
// (src/plugins/host-cards.ts): registration, lifecycle,
// update key, string fallback, unmount cleanup. Pure
// registry logic — no DOM, no Electron.
import { afterEach, describe, expect, it } from "vitest";
import {
  cardNodeStateKey,
  createCardNode,
  getCardHtml,
  getMountedCardNode,
  hasNodeRenderer,
  mountCardNode,
  unmountAllCardNodes,
  unmountCardNode,
  unmountCardNodesExcept,
  updateMountedCardNode,
} from "../../src/plugins/host-cards";
import { cards } from "../../src/plugins/host-state";
import type { Item, PluginCardDef, PluginCardNode } from "bowerbird-plugin-api";

function pluginItem(id: number, data: unknown): Item {
  return {
    id, pos: { x: 10, y: 20 }, size: { w: 260, h: 96 }, group: null,
    kind: { Plugin: { plugin: "test-plugin", kind: "node", data } },
  };
}

function stringItem(id: number, data: unknown): Item {
  return {
    id, pos: { x: 10, y: 20 }, size: { w: 260, h: 96 }, group: null,
    kind: { Plugin: { plugin: "test-plugin", kind: "plain", data } },
  };
}

function fakeNode(): Node {
  return {} as unknown as Node;
}

function registerDef(kind: string, def: Partial<PluginCardDef>): void {
  cards.set(`test-plugin:${kind}`, {
    kind, title: kind, render: () => "<div>plain</div>", pluginId: "test-plugin", ...def,
  });
}

afterEach(() => {
  unmountAllCardNodes();
  cards.delete("test-plugin:node");
  cards.delete("test-plugin:plain");
});

describe("hasNodeRenderer", () => {
  it("is false with no renderer registered", () => {
    expect(hasNodeRenderer(pluginItem(1, {}))).toBe(false);
  });
  it("is false for a string-only renderer", () => {
    registerDef("plain", {});
    expect(hasNodeRenderer(stringItem(1, {}))).toBe(false);
  });
  it("is true when renderNode is defined", () => {
    registerDef("node", { renderNode: () => ({ node: fakeNode() }) });
    expect(hasNodeRenderer(pluginItem(1, {}))).toBe(true);
  });
});

describe("createCardNode", () => {
  it("returns null with no node renderer", () => {
    registerDef("plain", {});
    expect(createCardNode(stringItem(1, {}))).toBeNull();
  });
  it("returns the handle renderNode built", () => {
    const node = fakeNode();
    registerDef("node", { renderNode: () => ({ node }) });
    expect(createCardNode(pluginItem(1, {}))).toEqual({ node });
  });
  it("returns null when renderNode hides the card", () => {
    registerDef("node", { renderNode: () => null });
    expect(createCardNode(pluginItem(1, {}))).toBeNull();
  });
  it("lets a throwing renderNode propagate, so the caller can fall back to the string path", () => {
    registerDef("node", { renderNode: () => { throw new Error("boom"); } });
    expect(() => createCardNode(pluginItem(1, {}))).toThrow("boom");
  });
  it("passes the item and its data to renderNode", () => {
    const seen: Array<{ item: Item; data: unknown }> = [];
    registerDef("node", {
      renderNode: (item, data) => {
        seen.push({ item, data });
        return { node: fakeNode() };
      },
    });
    const item = pluginItem(7, { text: "hi" });
    createCardNode(item);
    expect(seen).toEqual([{ item, data: { text: "hi" } }]);
  });
});

describe("cardNodeStateKey", () => {
  it("is stable for an unchanged item", () => {
    expect(cardNodeStateKey(pluginItem(1, { text: "a" }))).toBe(cardNodeStateKey(pluginItem(1, { text: "a" })));
  });
  it("changes when the data, position, size or rotation changes", () => {
    const base = cardNodeStateKey(pluginItem(1, { text: "a" }));
    expect(cardNodeStateKey(pluginItem(1, { text: "b" }))).not.toBe(base);
    const moved = pluginItem(1, { text: "a" });
    moved.pos = { x: 11, y: 20 };
    expect(cardNodeStateKey(moved)).not.toBe(base);
    const resized = pluginItem(1, { text: "a" });
    resized.size = { w: 261, h: 96 };
    expect(cardNodeStateKey(resized)).not.toBe(base);
    const rotated = pluginItem(1, { text: "a" });
    rotated.rotation = 90;
    expect(cardNodeStateKey(rotated)).not.toBe(base);
  });
});

describe("mount / update / unmount", () => {
  it("mounts a node and reads it back", () => {
    const handle: PluginCardNode = { node: fakeNode() };
    mountCardNode(1, handle, "k1");
    expect(getMountedCardNode(1)?.handle).toBe(handle);
  });
  it("does not call update when nothing changed", () => {
    let calls = 0;
    mountCardNode(1, { node: fakeNode(), update: () => { calls++; } }, cardNodeStateKey(pluginItem(1, { text: "a" })));
    expect(updateMountedCardNode(1, pluginItem(1, { text: "a" }))).toBe(true);
    expect(calls).toBe(0);
  });
  it("calls update once when the data changes, with the new item and data", () => {
    const seen: Array<{ item: Item; data: unknown }> = [];
    mountCardNode(1, {
      node: fakeNode(),
      update: (item, data) => { seen.push({ item, data }); },
    }, cardNodeStateKey(pluginItem(1, { text: "a" })));
    const next = pluginItem(1, { text: "b" });
    expect(updateMountedCardNode(1, next)).toBe(true);
    expect(seen).toEqual([{ item: next, data: { text: "b" } }]);
    // A second call with the same state does not fire again.
    expect(updateMountedCardNode(1, pluginItem(1, { text: "b" }))).toBe(true);
    expect(seen.length).toBe(1);
  });
  it("returns false when update hides the card", () => {
    mountCardNode(1, { node: fakeNode(), update: () => false }, "stale");
    expect(updateMountedCardNode(1, pluginItem(1, { text: "a" }))).toBe(false);
  });
  it("keeps a card showing when update throws", () => {
    mountCardNode(1, {
      node: fakeNode(),
      update: () => { throw new Error("boom"); },
    }, "stale");
    expect(updateMountedCardNode(1, pluginItem(1, { text: "a" }))).toBe(true);
  });
  it("returns true with no update handler", () => {
    mountCardNode(1, { node: fakeNode() }, "stale");
    expect(updateMountedCardNode(1, pluginItem(1, { text: "a" }))).toBe(true);
  });
  it("returns true for an unmounted card", () => {
    expect(updateMountedCardNode(99, pluginItem(99, {}))).toBe(true);
  });
});

describe("unmount cleanup", () => {
  it("calls unmount once and drops the card from the registry", () => {
    let calls = 0;
    mountCardNode(1, { node: fakeNode(), unmount: () => { calls++; } }, "k");
    unmountCardNode(1);
    expect(calls).toBe(1);
    expect(getMountedCardNode(1)).toBeUndefined();
    unmountCardNode(1);
    expect(calls).toBe(1);
  });
  it("does not call unmount for a card with no unmount handler", () => {
    mountCardNode(1, { node: fakeNode() }, "k");
    expect(() => unmountCardNode(1)).not.toThrow();
    expect(getMountedCardNode(1)).toBeUndefined();
  });
  it("keeps a throwing unmount from breaking the render that asked for it", () => {
    mountCardNode(1, { node: fakeNode(), unmount: () => { throw new Error("boom"); } }, "k");
    expect(() => unmountCardNode(1)).not.toThrow();
    expect(getMountedCardNode(1)).toBeUndefined();
  });
  it("unmounts everything except the kept ids", () => {
    const calls: number[] = [];
    mountCardNode(1, { node: fakeNode(), unmount: () => { calls.push(1); } }, "k");
    mountCardNode(2, { node: fakeNode(), unmount: () => { calls.push(2); } }, "k");
    mountCardNode(3, { node: fakeNode(), unmount: () => { calls.push(3); } }, "k");
    unmountCardNodesExcept(new Set([2]));
    expect(calls).toEqual([1, 3]);
    expect(getMountedCardNode(2)).toBeDefined();
  });
  it("unmounts everything with unmountAllCardNodes", () => {
    const calls: number[] = [];
    mountCardNode(1, { node: fakeNode(), unmount: () => { calls.push(1); } }, "k");
    mountCardNode(2, { node: fakeNode(), unmount: () => { calls.push(2); } }, "k");
    unmountAllCardNodes();
    expect(calls).toEqual([1, 2]);
    expect(getMountedCardNode(1)).toBeUndefined();
    expect(getMountedCardNode(2)).toBeUndefined();
  });
});

describe("HTML-string path untouched", () => {
  it("a def with renderNode still renders its string through getCardHtml", () => {
    registerDef("node", {
      render: (_item, data) => `<div>${String((data as { text: string }).text)}</div>`,
      renderNode: () => ({ node: fakeNode() }),
    });
    expect(getCardHtml(pluginItem(1, { text: "hello" }))).toBe("<div>hello</div>");
  });
  it("a def without renderNode renders its string as before", () => {
    registerDef("plain", {
      render: (_item, data) => `<div>${String((data as { text: string }).text)}</div>`,
    });
    expect(getCardHtml(stringItem(1, { text: "plain" }))).toBe("<div>plain</div>");
  });
});
