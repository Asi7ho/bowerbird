// Shared shape for an imported file's cards.

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
