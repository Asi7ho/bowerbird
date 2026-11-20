// model3d.ts — the 3D model viewer for Model3D cards.
//
// A Model3D card holds one GLB file (embedded in the board's
// assets). Drag rotates it, and it turns slowly on its own
// after a few seconds idle. There is no zoom: the model
// fills the card at its opening distance, and the wheel
// over the card pans or zooms the board, as over any card.
//
// One WebGL context serves every model on the board. A
// per-card renderer caps out at ~16 visible models
// (Chromium's context limit) — the 17th gets a lost context
// and renders blank. So there is one renderer and one
// offscreen canvas; each visible model is drawn into its
// card's screen rect with a scissor, and the pixels are
// then copied into the card's own canvas.
//
// The copy is the whole point: the model lives inside its
// card. A card dragged over a 3D card covers the cube, the
// way it covers any card; the card's own chrome (the title)
// paints above the model, the way it paints above any card;
// the rounded tile clips the model, the way it clips any
// card. A shared layer above the cards could do none of
// that — the cube floated over every card it overlapped,
// including the title on its own card.
//
// The shared canvas is offscreen (never in the DOM), so a
// render() that rebuilds #cards never touches it — there is
// nothing to detach or restore. A view is mounted when its
// card is rendered and dropped when the card leaves the
// viewport. The loaded model is cached by URL and the view
// angle is kept per card, so coming back is fast and the
// angle is where the user left it.
//
// GLB only: a .gltf references external buffers and textures
// that would not be embedded with it, so drops only accept
// .glb (see drops.ts).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Item } from "./model";

export interface Model3DDeps {
  fileUrl: (path: string) => string;
  // Select the card, as a board click would (shift adds to
  // the selection). setSelected only toggles classes — it
  // does not rebuild the DOM, so the viewer survives.
  onSelect: (id: number, additive: boolean) => void;
}

interface ViewState {
  azimuth: number;
  elevation: number;
  distance: number;
}

// The view a model opens with: straight on, slightly
// above the horizon, far enough that the whole model
// fills the card.
export function initialViewState(modelRadius: number): ViewState {
  return { azimuth: 0, elevation: 0.35, distance: modelRadius * 2.4 };
}

// The view angle per card, so a re-mount after the card
// leaves and re-enters the viewport restores it.
const viewState = new Map<number, ViewState>();
// The loaded model per URL, so a re-mount is a clone, not
// a re-fetch and re-parse. A failed load drops out of the
// cache so a retry fetches again.
const modelCache = new Map<string, Promise<THREE.Group>>();

const loader = new GLTFLoader();
const IDLE_MS = 3000;
const AUTO_ROTATE = 0.005;

// One view per visible Model3D card: its scene, camera and
// view angle. No renderer, no loop of its own — the shared
// renderer below draws all views in one pass.
class Model3DView {
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  // The model, centred at the origin, inside a root the
  // camera orbits. The cached template is never mutated:
  // each view clones it.
  private root = new THREE.Group();
  private modelRadius = 1;
  private azimuth: number;
  private elevation: number;
  private distance: number;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastInteract = 0;
  private disposed = false;
  private loaded = false;
  // The placeholder canvas this view is currently listening
  // on. render() rebuilds the card DOM, so the element
  // changes and the listeners move with it (see sync).
  private canvas: HTMLCanvasElement | null = null;
  // The card canvas's 2D context: the view's pixels are
  // copied here each frame (see blit), so the model lives
  // inside the card.
  private ctx: CanvasRenderingContext2D | null = null;

  constructor(
    private cardId: number,
    private url: string,
    private deps: Model3DDeps,
    env: THREE.Texture | null,
  ) {
    const saved = viewState.get(cardId);
    this.azimuth = saved?.azimuth ?? 0;
    this.elevation = saved?.elevation ?? 0.35;
    this.distance = saved?.distance ?? 3;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.scene.add(this.root);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    // A room environment so PBR materials (metalness and
    // roughness) read instead of going black — a plain
    // directional light alone leaves them flat. One texture
    // shared by every view.
    if (env) this.scene.environment = env;
    this.lastInteract = performance.now();
    this.load();
  }

  // The environment arrives after the view when the
  // renderer was set up on the startup path (see
  // ensureEnvTexture): apply it then, so the view never
  // renders unlit.
  setEnvironment(env: THREE.Texture): void {
    this.scene.environment = env;
  }

  // For sync: the model this view was built for. Card ids
  // restart at 1 on every board, so a board switch can reuse
  // an id for a different model — the view must not survive that.
  get sourceUrl(): string {
    return this.url;
  }

  private async load(): Promise<void> {
    let template: THREE.Group;
    try {
      template = await loadModel(this.url);
    } catch {
      if (this.disposed) return;
      this.showError("Could not load this 3D model.");
      return;
    }
    if (this.disposed) return;
    const model = template.clone();
    // Centre the model at the origin and frame it: the
    // camera distance comes from the bounding sphere, so
    // a tiny ring and a whole building both fill the card.
    const box = new THREE.Box3().setFromObject(model);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const centre = sphere.center;
    model.position.sub(centre);
    this.root.clear();
    this.root.add(model);
    this.modelRadius = Math.max(sphere.radius, 0.01);
    if (!viewState.has(this.cardId)) {
      this.distance = initialViewState(this.modelRadius).distance;
    }
    this.distance = THREE.MathUtils.clamp(this.distance, this.modelRadius * 1.1, this.modelRadius * 6);
    this.loaded = true;
  }

  private showError(message: string): void {
    // The placeholder becomes the error tile. The view is
    // dropped by sync (its canvas is gone), so this only
    // has to swap the element.
    if (!this.canvas) return;
    const el = document.createElement("div");
    el.className = "model3d-error";
    el.textContent = message;
    this.canvas.replaceWith(el);
    this.canvas = null;
  }

  // (Re)attach the pointer handlers to the card's current
  // placeholder canvas. Called by sync after every render.
  // The canvas is a 2D canvas now: the shared layer renders
  // offscreen and each frame is copied here, so size its
  // backing store to the card at the device pixel ratio.
  attach(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas) return;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    canvas.addEventListener("pointerdown", this.onPointerDown);
  }

  // Copy this frame's pixels from the shared layer into the
  // card's own canvas. The layer reads top-origin as an
  // image, so the source rect is the card's rect without
  // the WebGL y-flip; the copy scales into the canvas's
  // backing store. The canvas is cleared first, or the
  // previous frame would show through where the model
  // moved. The card's grey tile is the canvas's own
  // background, so transparent pixels stay grey — and the
  // card's chrome (the title) paints above the copy,
  // because it is above the canvas in the card.
  blit(layer: HTMLCanvasElement, rect: { x: number; y: number; w: number; h: number }, dpr: number): void {
    if (!this.ctx || !this.canvas) return;
    const wantW = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const wantH = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== wantW || this.canvas.height !== wantH) {
      this.canvas.width = wantW;
      this.canvas.height = wantH;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(
      layer,
      Math.round(rect.x * dpr), Math.round(rect.y * dpr),
      Math.round(rect.w * dpr), Math.round(rect.h * dpr),
      0, 0, this.canvas.width, this.canvas.height,
    );
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.canvas) return;
    // Select the card, then keep the board from starting a
    // move drag: the drag belongs to the model.
    this.deps.onSelect(this.cardId, e.shiftKey);
    e.stopPropagation();
    e.preventDefault();
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastInteract = performance.now();
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.azimuth += dx * 0.008;
    // Elevation is the angle above the horizon: clamp it so
    // the camera never goes fully under the floor or over
    // the top.
    this.elevation = THREE.MathUtils.clamp(this.elevation + dy * 0.008, -0.2, 1.5);
    this.lastInteract = performance.now();
  };

  private onPointerUp = (): void => {
    this.dragging = false;
    this.lastInteract = performance.now();
    if (!this.canvas) return;
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
  };

  // The placeholder's screen rect, in CSS pixels relative
  // to the shared canvas. Null when the card is gone or
  // has no size (not visible).
  rectRelativeTo(boardRect: DOMRect): { x: number; y: number; w: number; h: number } | null {
    if (!this.canvas || !this.canvas.isConnected) return null;
    const r = this.canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.x - boardRect.x, y: r.y - boardRect.y, w: r.width, h: r.height };
  }

  // Advance the idle auto-rotate and place the camera for
  // this frame. Returns false when the view has nothing to
  // draw yet (model still loading, or the shared room
  // environment not built yet — the card keeps its grey
  // tile until then, so a model never shows unlit).
  step(now: number): boolean {
    if (!this.dragging && now - this.lastInteract > IDLE_MS) {
      this.azimuth += AUTO_ROTATE;
    }
    if (!this.loaded || !this.scene.environment) return false;
    const { azimuth, elevation, distance } = this;
    this.camera.position.set(
      distance * Math.cos(elevation) * Math.sin(azimuth),
      distance * Math.sin(elevation),
      distance * Math.cos(elevation) * Math.cos(azimuth),
    );
    this.camera.lookAt(0, 0, 0);
    return true;
  }

  setAspect(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get isConnected(): boolean {
    return !!this.canvas && this.canvas.isConnected;
  }

  dispose(): void {
    this.disposed = true;
    if (this.canvas) {
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("pointermove", this.onPointerMove);
      this.canvas.removeEventListener("pointerup", this.onPointerUp);
      this.canvas.removeEventListener("pointercancel", this.onPointerUp);
      this.canvas = null;
      this.ctx = null;
    }
    viewState.set(this.cardId, {
      azimuth: this.azimuth,
      elevation: this.elevation,
      distance: this.distance,
    });
  }

  // For the shared renderer: the scene and camera to draw.
  get drawScene(): THREE.Scene {
    return this.scene;
  }
  get drawCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }
}

function loadModel(url: string): Promise<THREE.Group> {
  let p = modelCache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((gltf) => gltf.scene);
    modelCache.set(url, p);
    p.catch(() => {
      modelCache.delete(url);
    });
  }
  return p;
}

// ---------------------------------------------------------------- shared renderer

// Live views, keyed by card id.
const views = new Map<number, Model3DView>();
// The single renderer and its canvas, created lazily on
// the first Model3D card. One context, however many models.
let renderer: THREE.WebGLRenderer | null = null;
let sharedCanvas: HTMLCanvasElement | null = null;
let envTexture: THREE.Texture | null = null;
let pmrem: THREE.PMREMGenerator | null = null;
let raf = 0;
let boardEl: HTMLElement | null = null;
let sharedSetupScheduled = false;

function ensureSharedCanvas(board: HTMLElement): void {
  boardEl = board;
  if (renderer || sharedSetupScheduled) return;
  // Creating the WebGL context is the expensive part of
  // this setup, and the first render is the startup path
  // — so the whole shared layer (context, room
  // environment) is built once the renderer is idle, not
  // here. Views mount and load without it; the loop only
  // starts once it exists (see setupSharedCanvas), and
  // views render only once the environment exists (see
  // step), so a model never shows unlit. Until then the
  // card keeps its grey tile.
  sharedSetupScheduled = true;
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => setupSharedCanvas(), { timeout: 1000 });
  } else {
    setTimeout(() => setupSharedCanvas(), 100);
  }
}

// Build the shared offscreen layer (context, room
// environment) once the renderer is idle after setup. A
// board switch before it fires disposes the board, so
// there is nothing to build for; a new board's setup
// schedules its own.
function setupSharedCanvas(): void {
  sharedSetupScheduled = false;
  if (renderer || !boardEl) return;
  // An offscreen render target, never in the DOM: the
  // pixels reach the screen only through the per-card
  // copies (see blit), so nothing here can paint over a
  // card or a button. preserveDrawingBuffer so the copies
  // can read the layer after the frame is composited.
  sharedCanvas = document.createElement("canvas");
  sharedCanvas.id = "model3d-layer";
  renderer = new THREE.WebGLRenderer({ canvas: sharedCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  pmrem = new THREE.PMREMGenerator(renderer);
  envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  for (const view of views.values()) view.setEnvironment(envTexture);
  kickLoop();
}

function loop(): void {
  raf = 0;
  if (!renderer || !sharedCanvas || !boardEl) return;
  if (views.size === 0) return;
  const now = performance.now();
  const dpr = Math.min(window.devicePixelRatio, 2);
  const bw = boardEl.clientWidth;
  const bh = boardEl.clientHeight;
  if (bw <= 0 || bh <= 0) {
    raf = requestAnimationFrame(loop);
    return;
  }
  // Size the drawing buffer to the board, in device pixels.
  const wantW = Math.round(bw * dpr);
  const wantH = Math.round(bh * dpr);
  if (sharedCanvas.width !== wantW || sharedCanvas.height !== wantH) {
    renderer.setSize(bw, bh, false);
  }
  const boardRect = boardEl.getBoundingClientRect();
  renderer.setScissorTest(false);
  // setViewport and setScissor take logical pixels and
  // scale by the pixel ratio themselves — passing device
  // pixels scales twice, so on a Retina display the model
  // lands at 4x its rect: off-screen, or oversized and
  // offset where part of it still lands on the layer.
  renderer.setViewport(0, 0, bw, bh);
  renderer.clear();
  // One pass over the views: each gets its card's screen
  // rect as a scissored viewport, then its pixels are
  // copied into its own card canvas (see blit) — the layer
  // itself never reaches the screen.
  renderer.setScissorTest(true);
  for (const view of views.values()) {
    const rect = view.rectRelativeTo(boardRect);
    if (!rect) continue;
    // WebGL y is from the bottom; DOM y is from the top.
    // Logical pixels, not device pixels (see above).
    const x = Math.round(rect.x);
    const y = Math.round(bh - rect.y - rect.h);
    const w = Math.round(rect.w);
    const h = Math.round(rect.h);
    if (w <= 0 || h <= 0) continue;
    view.setAspect(rect.w, rect.h);
    if (!view.step(now)) continue;
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    // No per-view clear: the layer is cleared once above,
    // and the card's grey tile is its own canvas's
    // background, under the copy.
    renderer.render(view.drawScene, view.drawCamera);
    view.blit(sharedCanvas, rect, dpr);
  }
  renderer.setScissorTest(false);
  raf = requestAnimationFrame(loop);
}

function kickLoop(): void {
  if (raf === 0 && views.size > 0) raf = requestAnimationFrame(loop);
}

// Mount views for the Model3D cards currently in the DOM
// and drop views whose card is gone or off-screen. Called
// after render() in board.ts. The shared canvas survives
// renders (it lives in #board, not #cards), so there is
// nothing to detach or restore.
export function syncModel3DViews(
  board: HTMLElement,
  cardsEl: HTMLElement,
  items: Item[],
  deps: Model3DDeps,
): void {
  ensureSharedCanvas(board);
  const seen = new Set<number>();
  for (const canvas of Array.from(cardsEl.querySelectorAll<HTMLCanvasElement>("canvas.model3d"))) {
    const card = canvas.closest<HTMLElement>(".card[data-id]");
    if (!card) continue;
    const id = Number(card.dataset.id);
    if (!Number.isFinite(id)) continue;
    const item = items.find((it) => it.id === id);
    if (!item || !("Model3D" in item.kind)) continue;
    seen.add(id);
    const url = deps.fileUrl(item.kind.Model3D.path);
    let view = views.get(id);
    if (view && view.sourceUrl !== url) {
      // Same card id, different board: the old view draws
      // the old board's model. Drop it — and its saved view
      // angle, which belonged to that model — so the new
      // model mounts fresh.
      view.dispose();
      views.delete(id);
      viewState.delete(id);
      view = undefined;
    }
    if (!view) {
      view = new Model3DView(id, url, deps, envTexture);
      views.set(id, view);
    }
    // render() rebuilds the card DOM, so the placeholder
    // element changes; the listeners move with it.
    view.attach(canvas);
  }
  for (const [id, view] of Array.from(views)) {
    if (!seen.has(id) || !view.isConnected) {
      view.dispose();
      views.delete(id);
    }
  }
  // No wipe when the views hit zero: the layer is offscreen
  // now, so a stale frame there never reaches the screen —
  // and the next mount clears it at the frame start.
  kickLoop();
}

// Dispose every view (board switch / teardown) and drop
// the offscreen layer.
export function disposeAllModel3DViewers(): void {
  for (const [id, view] of Array.from(views)) {
    view.dispose();
    views.delete(id);
  }
  if (raf !== 0) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  if (renderer) {
    pmrem?.dispose();
    renderer.dispose();
    renderer = null;
    pmrem = null;
    envTexture = null;
  }
  sharedSetupScheduled = false;
  sharedCanvas = null;
  boardEl = null;
}
