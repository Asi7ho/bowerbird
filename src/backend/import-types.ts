// Shared shape for an imported file's cards.
//
// A parser (SVG, ...) turns a file into these; the drop
// flow in drops.ts then stores any raster bytes and pushes
// the items onto the board. The kind's Image path is filled
// in by the drop flow — a parser never knows the stored
// path, so an Image card arrives with a placeholder path
// and `embed` carrying the bytes.
import type { Kind, Pt, Size } from "bowerbird-plugin-api";

export interface ImportedItem {
  kind: Kind;
  pos: Pt;
  size: Size;
  rotation?: number;
  // Raster bytes for an Image card, already encoded (an SVG
  // <image> with a data: URI). The drop flow embeds these
  // and rewrites the kind's path.
  embed?: { name: string; data: Uint8Array };
}
