// Presentation — shared state. The plugin's modules all read and
// write this one object: the slide list and the playing index,
// the view/panel/overlay element refs, the event handlers, and
// the presentation audio refs. It lives in its own module so no
// module has to import main.ts, and so the state has one home
// instead of being scattered across the modules that use it.
//
// The fields are the same ones main.js kept as module-level lets.
// They are properties of one object, not separate exports, so a
// module that needs several of them imports one name. A module
// that reads a nullable ref after a guard captures it into a
// local first: a property read is not narrowed across a function
// call the way a local is, so `state.stage` after a guard would
// not stay non-null past the next call, but a local does.
import type { Item } from "../../src/model";
import type { PluginContext } from "../../src/plugins";

export interface Slide {
  frame: Item;
  cards: Item[];
  drawings: Item[];
}

export interface DrawStart {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

export interface PresentationState {
  api: PluginContext | null;
  slides: Slide[];
  index: number;
  pendingStartIndex: number | null;
  lastSignature: string;
  // View refs (built on each activation, cleared on hide).
  viewBuilt: boolean;
  stage: HTMLElement | null;
  prevBtn: HTMLButtonElement | null;
  nextBtn: HTMLButtonElement | null;
  counter: HTMLElement | null;
  // Panel refs (built once by initPanel, cleared on deactivate).
  panelList: HTMLElement | null;
  panelPlayBtn: HTMLButtonElement | null;
  panelExportBtn: HTMLButtonElement | null;
  // Overlay refs (built once by initOverlay, cleared on deactivate).
  drawLayer: HTMLElement | null;
  drawInstruction: HTMLElement | null;
  drawPreview: HTMLElement | null;
  drawActive: boolean;
  drawStart: DrawStart | null;
  drawMoved: boolean;
  onBoardHandler: (() => void) | null;
  onViewHandler: (() => void) | null;
  resizeHandler: (() => void) | null;
  drawKeyHandler: ((e: KeyboardEvent) => void) | null;
  // One presentation audio at a time, played through a plain
  // Audio element (the core's audio player belongs to the
  // board). Refs are to the current slide's DOM, which is
  // rebuilt on every slide change, so playback always stops
  // when you move on.
  presAudio: HTMLAudioElement | null;
  presAudioItemId: number | null;
  presAudioTile: HTMLElement | null;
  presAudioSeek: HTMLInputElement | null;
  presAudioTime: HTMLElement | null;
  presAudioDur: HTMLElement | null;
}

export const state: PresentationState = {
  api: null,
  slides: [],
  index: 0,
  pendingStartIndex: null,
  lastSignature: "",
  viewBuilt: false,
  stage: null,
  prevBtn: null,
  nextBtn: null,
  counter: null,
  panelList: null,
  panelPlayBtn: null,
  panelExportBtn: null,
  drawLayer: null,
  drawInstruction: null,
  drawPreview: null,
  drawActive: false,
  drawStart: null,
  drawMoved: false,
  onBoardHandler: null,
  onViewHandler: null,
  resizeHandler: null,
  drawKeyHandler: null,
  presAudio: null,
  presAudioItemId: null,
  presAudioTile: null,
  presAudioSeek: null,
  presAudioTime: null,
  presAudioDur: null,
};

// The API, set in activate and cleared in deactivate. Modules
// that touch the plugin API go through this, so a call before
// activation fails loudly instead of reading a property off
// null. The few places that already guard on the API being set
// (startDrawMode, exportSlides, onKeyDown) read state.api
// directly and keep their guard.
export function getApi(): PluginContext {
  if (!state.api) throw new Error("Presentation plugin: not activated");
  return state.api;
}
