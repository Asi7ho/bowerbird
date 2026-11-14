// Voice Notes — bundled Bowerbird plugin (see PLUGIN_API.md).
//
// No panel: double-clicking empty board space offers "Type"
// or "Record voice", and the recording is an overlay pill at
// the point — a red dot, the elapsed time, and Stop. On Stop
// the recording is embedded as a board-owned file, transcribed
// on-device, and added as an audio card at the point, with
// its transcript under the player when there is one. The
// microphone permission is granted by the main process (see
// electron/main.ts); on macOS the OS still asks the first
// time, and a packaged build needs the audio-input
// entitlement. No recording leaves the machine: the audio is
// a file in the board's assets folder, like any dropped file,
// and the transcript is text on the card.
import type { PluginContext } from "../../src/plugins";
import type { Pt } from "../../src/model";

const MIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

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

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let pill: HTMLDivElement | null = null;
let timeEl: HTMLElement | null = null;
let stopBtn: HTMLButtonElement | null = null;

function setStatus(text: string): void {
  if (timeEl) timeEl.textContent = text;
}

function setRecording(on: boolean): void {
  if (pill) pill.hidden = !on;
  if (stopBtn) stopBtn.hidden = !on;
  if (pill) pill.classList.toggle("recording", on);
}

function stopTimer(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

function stopStream(): void {
  if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
}

function showPill(api: PluginContext, world: Pt): void {
  if (!pill) return;
  // The overlay wrap covers the board element, so the pill
  // is placed in board-relative coords: the click point in
  // screen space, above the spot the card will land on.
  const cam = api.view.getCamera();
  pill.style.left = `${(world.x - cam.x) * cam.zoom}px`;
  pill.style.top = `${(world.y - cam.y) * cam.zoom}px`;
  pill.hidden = false;
}

async function startRecording(api: PluginContext, world: Pt): Promise<void> {
  if (recorder && recorder.state !== "inactive") return;
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    api.ui.toast("Recording is not supported here.");
    return;
  }
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError") api.ui.toast("Microphone blocked — allow it and try again.");
    else if (name === "NotFoundError") api.ui.toast("No microphone found.");
    else api.ui.toast("Could not open the microphone.");
    return;
  }
  const mime = pickMime();
  stream = mic;
  chunks = [];
  recorder = new MediaRecorder(mic, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => void finishRecording(api, world, mime);
  recorder.start(250);
  startedAt = Date.now();
  showPill(api, world);
  setRecording(true);
  setStatus(`Recording ${fmtElapsed(0)}`);
  timer = setInterval(() => setStatus(`Recording ${fmtElapsed(Date.now() - startedAt)}`), 250);
}

async function finishRecording(api: PluginContext, world: Pt, mime: string): Promise<void> {
  stopTimer();
  stopStream();
  const blob = new Blob(chunks, { type: mime || "audio/webm" });
  chunks = [];
  if (blob.size === 0) {
    setRecording(false);
    api.ui.toast("Nothing was recorded.");
    return;
  }
  setStatus("Transcribing…");
  if (stopBtn) stopBtn.hidden = true;
  const file = new File([blob], fileName(mime), { type: blob.type });
  try {
    const [path, transcript] = await Promise.all([
      api.files.embedFile(file),
      api.media.transcribeAudio(blob),
    ]);
    // Short by default: the transcript stays hidden behind
    // its toggle until the user expands the card. The heights
    // come from the API, so the card matches the built-in
    // renderer instead of repeating its numbers.
    const h = transcript ? api.cards.audioHeights.transcriptHidden : api.cards.audioHeights.plain;
    const id = api.board.addItem({ Audio: { path, ...(transcript ? { transcript } : {}) } }, { x: world.x - 150, y: world.y - h / 2 }, { w: 300, h });
    api.board.setSelected([id]);
  } catch {
    api.ui.toast("Could not save the recording.");
  } finally {
    setRecording(false);
  }
}

function stopRecording(): void {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  } else {
    stopTimer();
    stopStream();
    setRecording(false);
  }
}

export async function activate(api: PluginContext): Promise<void> {
  api.ui.registerCreateAction({
    id: "record-voice",
    label: "Record voice",
    icon: MIC_ICON,
    run: (world: Pt) => void startRecording(api, world),
  });
  api.ui.registerOverlay({
    id: "voice-recording",
    render: (container) => {
      const el = document.createElement("div");
      el.className = "vn-recording";
      el.hidden = true;
      const dot = document.createElement("span");
      dot.className = "vn-dot";
      const time = document.createElement("span");
      time.className = "vn-time";
      time.textContent = "Recording 0:00";
      const stop = document.createElement("button");
      stop.className = "vn-stop";
      stop.type = "button";
      stop.textContent = "Stop";
      stop.addEventListener("click", () => stopRecording());
      el.append(dot, time, stop);
      pill = el;
      timeEl = time;
      stopBtn = stop;
      container.appendChild(el);
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
  pill = null;
  timeEl = null;
  stopBtn = null;
}
