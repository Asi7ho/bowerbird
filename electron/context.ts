// Context search models, main process only.
//
// Local, private, no cloud: images and video frames are
// embedded with CLIP (Xenova/clip-vit-base-patch32), audio
// is labelled with AST (Xenova/ast-finetuned-audioset).
// Models download once on first context search, into
// userData/models, and are cached there afterwards.
// Nothing about a board file ever leaves the machine.
//
// Package warning, learned the hard way on 2026-11-01:
// @xenova/transformers is pinned to exactly 2.17.2.
// Do NOT run `npm audit fix --force`: it downgrades
// transformers to 1.4.2, which depends on canvas 2.11.2,
// which has no prebuilt binary for Node 26 on Mac arm64
// and fails to build from source (needs pkg-config and
// pixman). Instead, package.json `overrides` force
// sharp to 0.35.5 and protobufjs to 7.6.6, which fixes
// all 5 audit vulnerabilities (sharp libvips/libheif/
// librsvg, protobufjs critical code execution) and
// drops the deprecated prebuild-install, with no
// downgrade and no install-script approval needed.
// Bowerbird itself still runs without the models; only
// context search is unavailable if they fail to load.
//
// CLIP in Transformers.js v2 needs both an image and a
// text input for a forward pass, even when only one
// embedding is wanted, so image-only calls use a dummy
// one-token text, and text-only calls use a dummy black
// image. The returned embedding for the wanted side is
// unaffected by the dummy side.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "electron";
import type { CLIPModel, PreTrainedTokenizer, Processor, RawImage } from "@xenova/transformers";

type TransformersModule = typeof import("@xenova/transformers");

interface ClipBundle {
  tokenizer: PreTrainedTokenizer;
  processor: Processor;
  model: CLIPModel;
  RawImage: typeof RawImage;
}

// The audio pipeline, typed by the one way it is called:
// an array of samples in, the top labels out.
type AudioPipeline = (input: Float32Array, options: { topk: number }) => Promise<Array<{ label: string; score: number }>>;

// The speech pipeline, typed by the one way it is called:
// 16kHz mono samples in, the transcript text out.
type WhisperPipeline = (input: Float32Array) => Promise<{ text: string }>;

let transformers: TransformersModule | null = null;
let clip: ClipBundle | null = null; // { tokenizer, processor, model }
let ast: AudioPipeline | null = null; // pipeline
let whisper: WhisperPipeline | null = null; // pipeline
let whisperQueue: Promise<unknown> = Promise.resolve();
let frameSeq = 0;
let clipLoading: Promise<ClipBundle> | null = null;
let astLoading: Promise<AudioPipeline> | null = null;
let whisperLoading: Promise<WhisperPipeline> | null = null;

function modelsDir(app: App): string {
  try {
    return path.join(app.getPath("userData"), "models");
  } catch {
    return path.join(os.tmpdir(), "bowerbird-models");
  }
}

async function loadTransformers(app: App): Promise<TransformersModule> {
  if (!transformers) {
    transformers = await import("@xenova/transformers");
    transformers.env.cacheDir = modelsDir(app);
    // OnnxRuntime in Electron's main process runs on CPU;
    // no GPU / WASM backends are needed or wanted here.
    transformers.env.backends = transformers.env.backends || {};
    if (transformers.env.backends.onnx) {
      transformers.env.backends.onnx.wasm = transformers.env.backends.onnx.wasm || {};
      // Ask ONNX Runtime to log errors only. Note: this does
      // NOT silence the model-load lines about unused
      // initialisers — ORT 1.14 prints those from its native
      // model loader regardless of the log level (verified:
      // logLevel error, logSeverityLevel fatal, and graph
      // optimisation off all still print them). They appear
      // once per launch when a model first loads, are
      // harmless, and the model still works.
      transformers.env.backends.onnx.logLevel = "error";
    }
  }
  return transformers;
}

async function loadClip(app: App): Promise<ClipBundle> {
  if (clip) return clip;
  if (!clipLoading) {
    clipLoading = (async () => {
      const t = await loadTransformers(app);
      const tokenizer = await t.AutoTokenizer.from_pretrained("Xenova/clip-vit-base-patch32");
      const processor = await t.AutoProcessor.from_pretrained("Xenova/clip-vit-base-patch32");
      const model = await t.CLIPModel.from_pretrained("Xenova/clip-vit-base-patch32");
      clip = { tokenizer, processor, model, RawImage: t.RawImage };
      return clip;
    })().catch((e: unknown) => { clipLoading = null; throw e; });
  }
  return clipLoading;
}

async function loadAst(app: App): Promise<AudioPipeline> {
  if (ast) return ast;
  if (!astLoading) {
    astLoading = (async () => {
      const t = await loadTransformers(app);
      ast = await t.pipeline("audio-classification", "Xenova/ast-finetuned-audioset-10-10-0.4593") as AudioPipeline;
      return ast;
    })().catch((e: unknown) => { astLoading = null; throw e; });
  }
  return astLoading;
}

async function loadWhisper(app: App): Promise<WhisperPipeline> {
  if (whisper) return whisper;
  if (!whisperLoading) {
    whisperLoading = (async () => {
      const t = await loadTransformers(app);
      // The multilingual base model: it detects the language
      // itself, so an English or a French note transcribes
      // without the caller choosing. Base is a step up from
      // tiny in accuracy (tiny's transcripts were rough),
      // still small and fast on-device — no audio leaves
      // the machine. It downloads once (~145MB) on first
      // transcription and is cached afterwards.
      whisper = await t.pipeline("automatic-speech-recognition", "Xenova/whisper-base") as WhisperPipeline;
      return whisper;
    })().catch((e: unknown) => { whisperLoading = null; throw e; });
  }
  return whisperLoading;
}

function toArray(tensor: { data: ArrayLike<number> }): number[] {
  return Array.from(tensor.data);
}

export async function embedImageFile(app: App, filePath: string): Promise<number[]> {
  const c = await loadClip(app);
  const image = await c.RawImage.read(filePath);
  const imgInputs = await c.processor(image);
  const txtInputs = c.tokenizer(["a"], { padding: true });
  const out = await c.model({ ...imgInputs, ...txtInputs });
  return toArray(out.image_embeds);
}

export async function embedImageDataUrl(app: App, dataUrl: string): Promise<number[]> {
  // RawImage cannot read a data URL in Node, so go via
  // a temp file in userData, deleted afterwards.
  // embedImageFile loads the model; no need to load it here too.
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("not an image data URL");
  // Date.now() alone collides when two frames land in the
  // same millisecond: a per-process counter makes the name
  // unique.
  const tmp = path.join(os.tmpdir(), `bowerbird-frame-${Date.now()}-${process.pid}-${frameSeq++}.${match[1]}`);
  fs.writeFileSync(tmp, Buffer.from(match[2], "base64"));
  try {
    return await embedImageFile(app, tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp file is harmless */ }
  }
}

export async function embedText(app: App, text: string): Promise<number[]> {
  const c = await loadClip(app);
  const black = new c.RawImage(new Uint8Array(224 * 224 * 3), 224, 224, 3);
  const imgInputs = await c.processor(black);
  const txtInputs = c.tokenizer([text], { padding: true, truncation: true });
  const out = await c.model({ ...imgInputs, ...txtInputs });
  return toArray(out.text_embeds);
}

export async function classifyAudio(app: App, pcm: Float32Array | number[]): Promise<Array<{ label: string; score: number }>> {
  const pipe = await loadAst(app);
  const arr = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm);
  const out = await pipe(arr, { topk: 8 });
  return out.map((o) => ({ label: o.label, score: o.score }));
}

// Transcribe 16kHz mono speech to text, on-device. Null
// when there is nothing to transcribe, or the model cannot
// run — the caller still keeps the recording, just without
// a transcript.
export async function transcribeAudio(app: App, pcm: Float32Array | number[]): Promise<string | null> {
  const arr = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm);
  if (arr.length === 0) return null;
  // One Whisper pipeline, one inference at a time: two
  // concurrent calls would run on the same ONNX session.
  // Chain each run onto the last, and keep the chain alive
  // through a failure so one bad clip does not break the
  // next transcription.
  const task = whisperQueue.then(async () => {
    const pipe = await loadWhisper(app);
    const out = await pipe(arr);
    const text = (out.text ?? "").trim();
    return text.length > 0 ? text : null;
  });
  whisperQueue = task.catch(() => undefined);
  return task;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
