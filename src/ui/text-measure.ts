// Measuring a note's height from its rendered text, not from a
// character count.
//
// estimateTextHeight (model.ts) counts characters and divides by
// an assumed average character width. That is only ever an
// approximation: real text wraps on word boundaries, and the
// average glyph is narrower than the 0.55 factor assumes, so the
// estimate over-counts wrapped lines and the card ends up taller
// than its text — the empty space at a note's bottom growing with
// every paragraph typed. The only exact answer is to lay the text
// out the way the note itself lays it out and measure it.
//
// This probe is a hidden note-body, styled by the same CSS as a
// real one (.card .note-body), fed the same HTML the card
// renderer produces (renderMarkdownHtml), at the note's own width
// and font size. Its scrollHeight is the text's true height, so
// the card it implies fits the text exactly. One probe element is
// reused for every measurement; it is positioned off-screen and
// visibility-hidden, so it is laid out but never painted.
//
// The card height returned is the probe's content height less its
// bottom padding (which sits inside the decorations row) plus the
// decorations row itself — the same convention estimateTextHeight
// plus CARD_DECORATIONS_H follows. Where there is no DOM (unit
// tests, the CLI), it falls back to the estimate.
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
