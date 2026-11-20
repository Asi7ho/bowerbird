// Measure a note's height from its rendered text, not a
// character count: the estimate in model.ts over-counts wrapped
// lines, so the exact answer is to lay the text out the way
// the note does and measure it.

import { CARD_DECORATIONS_H, estimateTextHeight, renderMarkdownHtml } from "../backend/model";

let probeCard: HTMLDivElement | null = null;
let probeBody: HTMLDivElement | null = null;

function getProbe(): { card: HTMLDivElement; body: HTMLDivElement } | null {
  if (typeof document === "undefined") return null;
  if (!probeCard || !probeBody) {
    probeCard = document.createElement("div");
    probeCard.className = "card";
    probeCard.style.position = "fixed";
    probeCard.style.left = "-10000px";
    probeCard.style.top = "0";
    probeCard.style.visibility = "hidden";
    probeCard.style.pointerEvents = "none";
    probeCard.style.height = "auto";
    probeBody = document.createElement("div");
    probeBody.className = "note-body";
    probeCard.appendChild(probeBody);
    document.body.appendChild(probeCard);
  }
  return { card: probeCard, body: probeBody };
}

export function measureNoteCardHeight(text: string, fontSize: number, width: number): number {
  const probe = getProbe();
  if (!probe) return Math.max(40, estimateTextHeight(text, fontSize, width) + CARD_DECORATIONS_H);
  probe.card.style.width = `${width}px`;
  probe.body.style.fontSize = `${fontSize}px`;
  probe.body.innerHTML = renderMarkdownHtml(text, fontSize);
  const padBottom = parseFloat(getComputedStyle(probe.body).paddingBottom) || 0;
  const contentH = probe.body.scrollHeight;
  return Math.max(40, contentH - padBottom + CARD_DECORATIONS_H);
}
