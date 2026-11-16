// The crash-recovery offer: a modal sheet shown once at launch
// when the journal holds edits board.json does not. The user
// chooses explicitly — Restore brings the journalled board
// back (the current board is backed up first, so the choice
// is reversible), Discard drops the journal. There is no
// Escape or backdrop dismissal: discarding unsaved work by
// accident is the failure this dialog exists to prevent.
export function showRecoveryOffer(opts: {
  savedAt: number;
  onRestore: () => Promise<void>;
  onDiscard: () => Promise<void>;
}): void {
  if (document.getElementById("recovery-backdrop")) return;
  const backdrop = document.createElement("div");
  backdrop.id = "recovery-backdrop";
  backdrop.setAttribute("role", "presentation");
  const sheet = document.createElement("div");
  sheet.id = "recovery-dialog";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Unsaved changes found");
  const title = document.createElement("h2");
  title.textContent = "Unsaved changes found";
  const when = new Date(opts.savedAt).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const body = document.createElement("p");
  body.textContent =
    `Bowerbird closed with changes that never reached the board file (${when}). ` +
    `Restore them to pick up where you left off, or discard them.`;
  const actions = document.createElement("div");
  actions.className = "recovery-actions";
  const restoreBtn = document.createElement("button");
  restoreBtn.className = "recovery-restore";
  restoreBtn.textContent = "Restore changes";
  const discardBtn = document.createElement("button");
  discardBtn.className = "recovery-discard";
  discardBtn.textContent = "Discard";
  const close = () => {
    backdrop.remove();
  };
  restoreBtn.addEventListener("click", async () => {
    restoreBtn.disabled = true;
    discardBtn.disabled = true;
    try {
      await opts.onRestore();
    } finally {
      close();
    }
  });
  discardBtn.addEventListener("click", async () => {
    restoreBtn.disabled = true;
    discardBtn.disabled = true;
    try {
      await opts.onDiscard();
    } finally {
      close();
    }
  });
  // Typing in the dialog must never switch tools or delete a
  // card: the core window handler sees every keydown.
  sheet.addEventListener("keydown", (e) => e.stopPropagation());
  actions.appendChild(discardBtn);
  actions.appendChild(restoreBtn);
  sheet.appendChild(title);
  sheet.appendChild(body);
  sheet.appendChild(actions);
  backdrop.appendChild(sheet);
  document.body.appendChild(backdrop);
  restoreBtn.focus();
}
