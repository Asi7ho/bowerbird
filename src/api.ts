// Electron preload API (see electron/preload.ts). The renderer never
// touches Node or Electron directly; every privileged call goes through
// this bridge, which the main process exposes with context isolation on.
import type { PluginManifest } from "./plugins";

export interface BowerbirdAPI {
  platform: string;
  loadBoard(): Promise<{ json: string | null; board_path: string; board_dir: string; pdf_size_bytes: number; video_size_bytes: number; panelOrder?: string[]; buildId?: string }>;
  saveBoard(json: string): Promise<void>;
  listBoards(): Promise<Array<{ name: string; current: boolean; items: number }>>;
  createBoard(name: string): Promise<{ name: string }>;
  switchBoard(name: string): Promise<{ json: string; board_path: string; board_dir: string }>;
  renameBoard(oldName: string, newName: string): Promise<{ name: string }>;
  deleteBoard(name: string): Promise<{ wasCurrent: boolean }>;
  listBackups(): Promise<Array<{ name: string; items: number; size: number }>>;
  restoreBackup(name: string): Promise<{ json: string; board_path: string; board_dir: string }>;
  openBackupsFolder(): Promise<string>;
  resetBoard(): Promise<{ pdf_size_bytes: number; video_size_bytes: number }>;
  factoryReset(): Promise<{ ok: boolean }>;
  checkFile(filePath: string): Promise<{ path: string; exists: boolean; size: number; bundlePath: string; bundleExists: boolean; bundleSize: number }>;
  readFileBase64(filePath: string): Promise<{ mime: string; base64: string }>;
  contextEmbedImage(filePath: string): Promise<number[]>;
  contextEmbedFrame(dataUrl: string): Promise<number[]>;
  contextEmbedText(text: string): Promise<number[]>;
  contextClassifyAudio(pcm: Float32Array): Promise<{ label: string; score: number }[]>;
  contextIndexLoad(): Promise<Record<string, unknown>>;
  contextIndexSave(index: Record<string, unknown>): Promise<boolean>;
  contextIndexSaveSync(index: Record<string, unknown>): boolean;
  embedFile(path: string): Promise<string>;
  embedFileBytes(name: string, data: ArrayBuffer | Uint8Array): Promise<string>;
  listLibrary(): Promise<{ path: string; items: Array<{ name: string; path: string; relativePath: string; ext: string; kind: string; category: string | null; size_bytes: number; mtime_ms: number }>; categories: Array<{ name: string; count: number }>; uncategorizedCount: number }>;
  createLibraryCategory(name: string): Promise<string>;
  moveLibraryItem(relativePath: string, category: string | null): Promise<string>;
  readTextFile(path: string): Promise<string>;
  fileSize(path: string): Promise<number>;
  fetchPreview(url: string): Promise<{ title: string | null; description: string | null; image: string | null; icon: string | null }>;
  aiChat(opts: { base: string; model: string; messages: Array<{ role: string; content: string }> }): Promise<string>;
  aiHasKey(): Promise<boolean>;
  aiSetKey(key: string): Promise<boolean>;
  openExternal(target: string): Promise<void>;
  getAppSettings(): Promise<{ corner: string; panelOrder?: string[]; panelWidth?: number }>;
  setPanelWidth(width: number): Promise<number>;
  setCorner(corner: string): Promise<string>;
  setPanelOrder(order: string[]): Promise<string[]>;
  collapse(): Promise<void>;
  restore(): Promise<void>;
  moveWindow(dx: number, dy: number): void;
  minimise(): Promise<void>;
  closeWindow(): Promise<void>;
  quit(): Promise<void>;
  fullscreen(): Promise<boolean>;
  maximise(): Promise<boolean>;
  windowState(): Promise<{ maximised: boolean; fullscreen: boolean }>;
  getPathForFile(file: File): string;
  fileUrl(path: string): string;
  listPlugins(): Promise<PluginManifest[]>;
  readPluginFile(pluginId: string, relativePath: string): Promise<string>;
  getPluginEnabled(): Promise<Record<string, boolean>>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean>;
  installPlugin(plugin: { id: string; name: string; description: string; permissions: string[]; mainCode: string; styleCode: string }): Promise<PluginManifest>;
  pluginStorageGet(pluginId: string, key: string): Promise<unknown>;
  pluginStorageSet(pluginId: string, key: string, value: unknown): Promise<void>;
  pluginStorageDelete(pluginId: string, key: string): Promise<void>;
  secureStorageAvailable(): Promise<boolean>;
  secureStorageGet(pluginId: string, key: string): Promise<string | null>;
  secureStorageSet(pluginId: string, key: string, value: string): Promise<boolean>;
  secureStorageDelete(pluginId: string, key: string): Promise<void>;
}
declare global {
  interface Window { bowerbird: BowerbirdAPI }
}

export const api = window.bowerbird;
