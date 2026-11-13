// Checklist Progress — bundled Bowerbird plugin (see
// PLUGIN_API.md).
//
// A decorator only: no panel, no storage, no writes. For a
// Text card containing checklist lines, it shows `n/m`
// under the card — done over total. The task-line shape is
// the app's own (see toggleTaskLine in src/model.ts), so
// the count always agrees with what a click toggles.
import type { PluginContext } from "../../src/plugins";

const TASK_LINE = /^([-*]\s+)\[([ xX])\](\s+.*|)$/;

export async function activate(api: PluginContext): Promise<void> {
  api.cards.registerDecorator({
    id: "checklist",
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
