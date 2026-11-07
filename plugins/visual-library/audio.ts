// Visual Library — the library's audio preview. One preview
// at a time, played through a plain Audio element (the core's
// audio player belongs to the board). Owns the playing Audio
// element, which tile and controls it is wired to, and the
// per-path duration cache.
import type { PluginContext } from "../../src/plugins";
import type { Item } from "../../src/model";

let libAudio: HTMLAudioElement | null = null;
let libAudioItemId: number | null = null;
let libAudioTile: Element | null = null;
let libAudioSeek: HTMLInputElement | null = null;
let libAudioTime: Element | null = null;
let libAudioDur: Element | null = null;

// Audio durations by path, for the session: every
// library re-render used to spawn a throwaway Audio
// element per audio card just to read its duration, so
// a board with several audio cards re-fetched metadata
// on every board change. A path's duration does not
// change while the app runs.
const libAudioDurations = new Map<string, number>();

export function getLibAudioItemId(): number | null {
  return libAudioItemId;
}

export function hasLibAudio(): boolean {
  return libAudio !== null;
}

export function formatAudioTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function stopLibraryAudio(): void {
  if (libAudio) libAudio.pause();
  libAudio = null;
  libAudioItemId = null;
  libAudioTile = null;
  libAudioSeek = null;
  libAudioTime = null;
  libAudioDur = null;
}

export function rewireLibraryAudio(containers: Array<HTMLElement | null>): void {
  // After a re-render, point the playing preview's
  // tile, seek and time at the fresh DOM, so the
  // preview keeps playing and its controls keep
  // working instead of going dead on detached nodes.
  if (!libAudio || libAudioItemId === null) return;
  const wrap = containers
    .map((c) => c && c.querySelector(`[data-board-id="${libAudioItemId}"]`))
    .find(Boolean);
  if (!wrap) {
    libAudioTile = null;
    libAudioSeek = null;
    libAudioTime = null;
    libAudioDur = null;
    return;
  }
  libAudioTile = wrap.querySelector(".audio-tile");
  libAudioSeek = wrap.querySelector("input.audio-seek") as HTMLInputElement | null;
  libAudioTime = wrap.querySelector("[data-audio-time]");
  libAudioDur = wrap.querySelector("[data-audio-dur]");
  if (libAudioTile) libAudioTile.textContent = libAudio.paused ? "▶" : "❚❚";
  if (libAudioDur && isFinite(libAudio.duration)) libAudioDur.textContent = formatAudioTime(libAudio.duration);
  if (libAudioTime) libAudioTime.textContent = formatAudioTime(libAudio.currentTime);
  if (libAudioSeek && isFinite(libAudio.duration) && libAudio.duration > 0) {
    libAudioSeek.value = String(Math.round((libAudio.currentTime / libAudio.duration) * 1000));
  }
}

export function playLibraryAudio(api: PluginContext, item: Item, tile: Element, wrap: HTMLElement): void {
  // Only audio cards have a tile; the guard is the
  // type narrowing, not a behaviour change.
  if (!("Audio" in item.kind)) return;
  const path = item.kind.Audio.path;
  if (libAudioItemId === item.id && libAudio) {
    if (libAudio.paused) {
      libAudio.play().catch(() => undefined);
      tile.textContent = "❚❚";
    } else {
      libAudio.pause();
      tile.textContent = "▶";
    }
    return;
  }
  if (libAudio) {
    libAudio.pause();
    if (libAudioTile && libAudioTile.isConnected) libAudioTile.textContent = "▶";
  }
  const url = api.files.fileUrl(path);
  const audio = new Audio(url);
  libAudio = audio;
  libAudioItemId = item.id;
  libAudioTile = tile;
  libAudioSeek = wrap.querySelector("input.audio-seek") as HTMLInputElement | null;
  libAudioTime = wrap.querySelector("[data-audio-time]");
  libAudioDur = wrap.querySelector("[data-audio-dur]");
  audio.addEventListener("loadedmetadata", () => {
    if (libAudioDur && libAudioDur.isConnected) libAudioDur.textContent = formatAudioTime(audio.duration);
  });
  audio.addEventListener("timeupdate", () => {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    if (libAudioSeek && libAudioSeek.isConnected) libAudioSeek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    if (libAudioTime && libAudioTime.isConnected) libAudioTime.textContent = formatAudioTime(audio.currentTime);
  });
  audio.addEventListener("ended", () => {
    if (libAudioTile && libAudioTile.isConnected) libAudioTile.textContent = "▶";
    stopLibraryAudio();
  });
  audio.play().catch(() => undefined);
  tile.textContent = "❚❚";
}

// Move the playing preview's playhead to the seek
// position. Only the card that is playing seeks.
export function seekLibAudio(itemId: number, rawValue: number): void {
  if (libAudioItemId === itemId && libAudio && isFinite(libAudio.duration) && libAudio.duration > 0) {
    libAudio.currentTime = (rawValue / 1000) * libAudio.duration;
  }
}

export function loadLibraryAudioDuration(api: PluginContext, wrap: HTMLElement, item: Item): void {
  const dur = wrap.querySelector("[data-audio-dur]");
  if (!dur || dur.textContent !== "–:––") return;
  // Only audio cards carry a duration element; the
  // guard is the type narrowing, not a behaviour change.
  if (!("Audio" in item.kind)) return;
  const path = item.kind.Audio.path;
  const cached = libAudioDurations.get(path);
  if (cached !== undefined) {
    dur.textContent = formatAudioTime(cached);
    return;
  }
  const audio = new Audio(api.files.fileUrl(path));
  audio.addEventListener("loadedmetadata", () => {
    libAudioDurations.set(path, audio.duration);
    if (wrap.isConnected && dur.isConnected) dur.textContent = formatAudioTime(audio.duration);
  });
  audio.addEventListener("error", () => {});
}
