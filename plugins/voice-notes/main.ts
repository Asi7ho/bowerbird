// Voice Notes — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// Record a note straight onto the board: the panel's Record
// button captures the microphone with MediaRecorder, and on
// Stop the recording is embedded as a board-owned file and
// added as an audio card at the centre of the view. The
// microphone permission is granted by the main process (see
// electron/main.ts); on macOS the OS still asks the first
// time, and a packaged build needs the audio-input
// entitlement. No recording leaves the machine: the audio is
// a file in the board's assets folder, like any dropped file.
import type { PluginContext } from "../../src/plugins";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""];

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of MIME_CANDIDATES) {
    if (m === "" || MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function fileName(mime: string): string {
  const ext = mime.includes("mp4") ? "m4a" : "webm";
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `voice-note-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

let apiRef: PluginContext | null = null;
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let recordBtn: HTMLButtonElement | null = null;
let statusEl: HTMLElement | null = null;

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function setRecording(on: boolean): void {
  if (recordBtn) {
    recordBtn.textContent = on ? "Stop" : "Record";
    recordBtn.classList.toggle("recording", on);
  }
}

function stopTimer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

function stopStream(): void {
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
}

async function startRecording(api: PluginContext): Promise<void> {
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    setStatus("Recording is not supported here.");
    return;
  }
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError") setStatus("Microphone blocked — allow it and try again.");
    else if (name === "NotFoundError") setStatus("No microphone found.");
    else setStatus("Could not open the microphone.");
    return;
  }
  const mime = pickMime();
  stream = mic;
  chunks = [];
  recorder = new MediaRecorder(mic, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => void finishRecording(api, mime);
  recorder.start(250);
  startedAt = Date.now();
  setRecording(true);
  setStatus("Recording 0:00");
  timer = setInterval(() => setStatus(`Recording ${fmtElapsed(Date.now() - startedAt)}`), 250);
}

async function finishRecording(api: PluginContext, mime: string): Promise<void> {
  stopTimer();
  stopStream();
  setRecording(false);
  const blob = new Blob(chunks, { type: mime || "audio/webm" });
  chunks = [];
  if (blob.size === 0) {
    setStatus("Nothing was recorded.");
    return;
  }
  setStatus("Saving…");
  if (recordBtn) recordBtn.disabled = true;
  try {
    const file = new File([blob], fileName(mime), { type: blob.type });
    const path = await api.files.embedFile(file);
    const cam = api.view.getCamera();
    const el = api.ui.boardEl;
    const centre = { x: cam.x + el.clientWidth / 2 / cam.zoom, y: cam.y + el.clientHeight / 2 / cam.zoom };
    const id = api.board.addItem({ Audio: { path } }, { x: centre.x - 150, y: centre.y - 52 }, { w: 300, h: 104 });
    api.board.setSelected([id]);
    setStatus("Ready");
  } catch {
    setStatus("Could not save the recording.");
  } finally {
    if (recordBtn) recordBtn.disabled = false;
  }
}

function stopRecording(): void {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  } else {
    stopTimer();
    stopStream();
    setRecording(false);
    setStatus("Ready");
  }
}

export async function activate(api: PluginContext): Promise<void> {
  apiRef = api;
  api.ui.registerPanel({
    id: "voice-notes",
    title: "Voice Notes",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    render: (container) => {
      container.replaceChildren();
      const btn = document.createElement("button");
      btn.className = "vn-record";
      btn.type = "button";
      btn.textContent = "Record";
      btn.addEventListener("click", () => {
        if (!apiRef) return;
        if (recorder && recorder.state !== "inactive") stopRecording();
        else void startRecording(apiRef);
      });
      const status = document.createElement("div");
      status.className = "vn-status";
      status.textContent = "Ready";
      recordBtn = btn;
      statusEl = status;
      container.append(btn, status);
    },
  });
}

export function deactivate(): void {
  if (recorder && recorder.state !== "inactive") {
    try { recorder.stop(); } catch { /* already stopped */ }
  }
  stopTimer();
  stopStream();
  recorder = null;
  recordBtn = null;
  statusEl = null;
  apiRef = null;
}
