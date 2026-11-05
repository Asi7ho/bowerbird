# Tidy Up

Align and distribute the selected cards.

**Align** lines cards up to an edge or the centre of the whole selection — left, centre, right, top, middle, bottom. There is no key object to pick: the reference is always the selection's bounding box, so the result is the one you can picture before pressing the button.

**Distribute** spaces cards evenly: the first and last cards stay where they are, and the rest are placed with equal gaps between them. Cards that overlap end up touching rather than stacked.

- Needs 2 or more selected cards to align, 3 or more to distribute; the buttons are disabled otherwise.
- Cards only — strokes and connectors stay where they are, because moving a stroke needs its points moved too.
- Rotated cards align by their unrotated box, the same box the core uses for their handles.
- One tidy action is one undo step, through the core's batch `updateItems`.

This is a bundled plugin: it ships inside the app and is on by default.
