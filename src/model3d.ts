// model3d.ts — the 3D model viewer for Model3D cards.
//
// A Model3D card holds one GLB file (embedded in the board's
// assets). The viewer renders it with Three.js on a <canvas>
// inside the card: drag rotates, wheel zooms, and it turns
// slowly on its own after a few seconds idle.
//
// The viewer owns one WebGL context per visible card. A
// render() rebuilds the card DOM, which would destroy that
// context — so the board preserves Model3D card nodes across
// renders (detach/restore below) instead of rebuilding them.
// A viewer is disposed only when its card leaves the board
// or scrolls out of view. The loaded model is cached by URL
// and the view angle is kept per card, so coming back is
// fast and the angle is where the user left it.
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

// The view angle per card, so a re-mount after the card
// leaves and re-enters the viewport restores it.
const viewState = new Map<number, ViewState>();
// The loaded model per URL, so a re-mount is a clone, not
// a re-fetch and re-parse. A failed load drops out of the
// cache so a retry fetches again.
const modelCache = new Map<string, Promise<THREE.Group>>();
// Live viewers, keyed by card id.
const viewers = new Map<number, Model3DViewer>();

const loader = new GLTFLoader();
const IDLE_MS = 3000;
const AUTO_ROTATE = 0.005;

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

class Model3DViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  // The model, centred at the origin, inside a root the
  // camera orbits. The cached template is never mutated:
  // each viewer clones it.
  private root = new THREE.Group();
  private modelRadius = 1;
  private raf = 0;
  private azimuth: number;
  private elevation: number;
  private distance: number;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastInteract = 0;
  private disposed = false;
  private ro: ResizeObserver;
  private pmrem: THREE.PMREMGenerator | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private cardId: number,
    private url: string,
    private deps: Model3DDeps,
  ) {
    const saved = viewState.get(cardId);
    this.azimuth = saved?.azimuth ?? 0;
    this.elevation = saved?.elevation ?? 0.35;
    this.distance = saved?.distance ?? 3;
    // preserveDrawingBuffer so the canvas can be read back
    // (tests, and a future export): without it toDataURL
    // returns blank once the frame is composited.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.scene.add(this.root);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 3, 4);
    this.scene.add(key);
    // A room environment so PBR materials (metalness and
    // roughness) read instead of going black — a plain
    // directional light alone leaves them flat.
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = this.pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = env.texture;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.lastInteract = performance.now();
    this.load();
    this.loop();
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
      this.distance = this.modelRadius * 2.4;
    }
    this.distance = THREE.MathUtils.clamp(this.distance, this.modelRadius * 1.1, this.modelRadius * 6);
  }

  private showError(message: string): void {
    const el = document.createElement("div");
    el.className = "model3d-error";
    el.textContent = message;
    this.canvas.replaceWith(el);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
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
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
  };

  private onWheel = (e: WheelEvent): void => {
    // Zoom the model, not the board.
    e.stopPropagation();
    e.preventDefault();
    this.distance = THREE.MathUtils.clamp(
      this.distance * Math.exp(e.deltaY * 0.001),
      this.modelRadius * 1.1,
      this.modelRadius * 6,
    );
    this.lastInteract = performance.now();
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.dragging && performance.now() - this.lastInteract > IDLE_MS) {
      this.azimuth += AUTO_ROTATE;
    }
    const { azimuth, elevation, distance } = this;
    this.camera.position.set(
      distance * Math.cos(elevation) * Math.sin(azimuth),
      distance * Math.sin(elevation),
      distance * Math.cos(elevation) * Math.cos(azimuth),
    );
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  };

  resizeViewer(): void {
    this.resize();
  }

  get isConnected(): boolean {
    return this.canvas.isConnected;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    viewState.set(this.cardId, {
      azimuth: this.azimuth,
      elevation: this.elevation,
      distance: this.distance,
    });
    this.pmrem?.dispose();
    this.renderer.dispose();
  }
}

function disposeViewer(id: number): void {
  const v = viewers.get(id);
  if (!v) return;
  v.dispose();
  viewers.delete(id);
}

// Detach the Model3D card nodes from the card layer before a
// render rebuilds it, so their WebGL contexts survive. Called
// before `cardsEl.innerHTML = html` in board.ts render().
// Returns the nodes keyed by card id.
export function detachModel3DNodes(cardsEl: HTMLElement): Map<number, HTMLElement> {
  const kept = new Map<number, HTMLElement>();
  for (const el of Array.from(cardsEl.querySelectorAll<HTMLElement>(".card[data-id]"))) {
    if (!el.querySelector("canvas.model3d")) continue;
    const id = Number(el.dataset.id);
    if (!Number.isFinite(id)) continue;
    kept.set(id, el);
    el.remove();
  }
  return kept;
}

// Re-insert the preserved nodes into the freshly rendered card
// layer, dispose viewers whose card is gone or off-screen, and
// mount viewers on any new Model3D canvases. Called after
// `cardsEl.innerHTML = html` in board.ts render().
export function restoreModel3DNodes(
  cardsEl: HTMLElement,
  kept: Map<number, HTMLElement>,
  items: Item[],
  deps: Model3DDeps,
): void {
  for (const [id, node] of kept) {
    const item = items.find((it) => it.id === id);
    const placeholder = cardsEl.querySelector<HTMLElement>(`.card[data-id="${id}"]`);
    if (!item || !("Model3D" in item.kind) || !placeholder) {
      // Card removed or off-screen: free its context.
      disposeViewer(id);
      continue;
    }
    // The placeholder has the fresh style (pos/size/rotation)
    // and selection class; the kept node keeps its live canvas.
    node.setAttribute("style", placeholder.getAttribute("style") ?? "");
    node.className = placeholder.className;
    placeholder.replaceWith(node);
    viewers.get(id)?.resizeViewer();
  }
  // Mount viewers on Model3D canvases that have none yet.
  for (const canvas of Array.from(cardsEl.querySelectorAll<HTMLCanvasElement>("canvas.model3d"))) {
    const card = canvas.closest<HTMLElement>(".card[data-id]");
    if (!card) continue;
    const id = Number(card.dataset.id);
    if (!Number.isFinite(id) || viewers.has(id)) continue;
    const path = canvas.dataset.path;
    if (!path) continue;
    const viewer = new Model3DViewer(canvas, id, deps.fileUrl(path), deps);
    viewers.set(id, viewer);
  }
  // Safety net: a viewer whose canvas is no longer connected
  // (its node was destroyed without going through restore)
  // would leak a context and a loop.
  for (const [id, viewer] of viewers) {
    if (!viewer.isConnected) {
      disposeViewer(id);
    }
  }
}

// Dispose every viewer (board switch / teardown).
export function disposeAllModel3DViewers(): void {
  for (const id of Array.from(viewers.keys())) disposeViewer(id);
}
