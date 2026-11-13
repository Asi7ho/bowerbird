// Checklist Progress is a first-party plugin
// (core-checklist-progress).
//
// A decorator only: no panel, no storage, no writes. For a
// Text card containing checklist lines, it shows `n/m` as
// plain text at the card's bottom right — done over total.
// The task-line shape is the app's own (see toggleTaskLine
// in src/model.ts), so the count always agrees with what a
// click toggles. It uses only the public API.
import type { PluginContext, PluginManifest } from "../plugins";

const TASK_LINE = /^([-*]\s+)\[([ xX])\](\s+.*|)$/;

export const manifest: PluginManifest = {
  id: "core-checklist-progress",
  name: "Checklist Progress",
  description: "Shows n/m under a note with a checklist.",
  version: "1.0.0",
  apiVersion: "2",
  main: "checklist-progress.js",
  permissions: ["board:read"],
};

export async function activate(api: PluginContext): Promise<void> {
  api.cards.registerDecorator({
    id: "checklist",
    side: "right",
    render: (item) => {
      if (!("Text" in item.kind)) return null;
      let total = 0;
      let done = 0;
      for (const line of item.kind.Text.text.split("\n")) {
        const m = TASK_LINE.exec(line);
        if (!m) continue;
        total += 1;
        if (m[2] !== " ") done += 1;
      }
      if (total === 0) return null;
      return `<span class="card-progress">${done}/${total}</span>`;
    },
  });
}

export function deactivate(): void {
  // Nothing held: the core unregisters the decorator.
}
