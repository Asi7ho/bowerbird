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
// pixman). Transformers 2.x uses sharp, not canvas.
// On newer npm, sharp's install script (which downloads
// libvips) is blocked by default: approve it with
// `npm install-scripts approve sharp`, then `npm install`
// again, or image indexing will fail and search will
// fall back to filenames. Bowerbird itself still runs
// without it; only context search is unavailable.
//
// CLIP in Transformers.js v2 needs both an image and a
// text input for a forward pass, even when only one
// embedding is wanted, so image-only calls use a dummy
// one-token text, and text-only calls use a dummy black
// image. The returned embedding for the wanted side is
// unaffected by the dummy side.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let transformers = null;
let clip = null; // { tokenizer, processor, model }
let ast = null; // pipeline
let clipLoading = null;
let astLoading = null;

function modelsDir(app) {
  try {
    return path.join(app.getPath('userData'), 'models');
  } catch {
    return path.join(os.tmpdir(), 'bowerbird-models');
  }
}

async function loadTransformers(app) {
  if (!transformers) {
    transformers = require('@xenova/transformers');
    transformers.env.cacheDir = modelsDir(app);
    // OnnxRuntime in Electron's main process runs on CPU;
    // no GPU / WASM backends are needed or wanted here.
    transformers.env.backends = transformers.env.backends || {};
    if (transformers.env.backends.onnx) {
      transformers.env.backends.onnx.wasm = transformers.env.backends.onnx.wasm || {};
    }
  }
  return transformers;
}

async function loadClip(app) {
  if (clip) return clip;
  if (!clipLoading) {
    clipLoading = (async () => {
      const t = await loadTransformers(app);
      const tokenizer = await t.AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch32');
      const processor = await t.AutoProcessor.from_pretrained('Xenova/clip-vit-base-patch32');
      const model = await t.CLIPModel.from_pretrained('Xenova/clip-vit-base-patch32');
      clip = { tokenizer, processor, model, RawImage: t.RawImage };
      return clip;
    })().catch((e) => { clipLoading = null; throw e; });
  }
  return clipLoading;
}

async function loadAst(app) {
  if (ast) return ast;
  if (!astLoading) {
    astLoading = (async () => {
      const t = await loadTransformers(app);
      ast = await t.pipeline('audio-classification', 'Xenova/ast-finetuned-audioset-10-10-0.4593');
      return ast;
    })().catch((e) => { astLoading = null; throw e; });
  }
  return astLoading;
}

function toArray(tensor) {
  return Array.from(tensor.data);
}

async function embedImageFile(app, filePath) {
  const c = await loadClip(app);
  const image = await c.RawImage.read(filePath);
  const imgInputs = await c.processor(image);
  const txtInputs = c.tokenizer(['a'], { padding: true });
  const out = await c.model({ ...imgInputs, ...txtInputs });
  return toArray(out.image_embeds);
}

async function embedImageDataUrl(app, dataUrl) {
  // RawImage cannot read a data URL in Node, so go via
  // a temp file in userData, deleted afterwards.
  const c = await loadClip(app);
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('not an image data URL');
  const tmp = path.join(os.tmpdir(), `bowerbird-frame-${Date.now()}.${match[1]}`);
  fs.writeFileSync(tmp, Buffer.from(match[2], 'base64'));
  try {
    return await embedImageFile(app, tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp file is harmless */ }
  }
}

async function embedText(app, text) {
  const c = await loadClip(app);
  const black = new c.RawImage(new Uint8Array(224 * 224 * 3), 224, 224, 3);
  const imgInputs = await c.processor(black);
  const txtInputs = c.tokenizer([text], { padding: true, truncation: true });
  const out = await c.model({ ...imgInputs, ...txtInputs });
  return toArray(out.text_embeds);
}

async function classifyAudio(app, pcm) {
  const pipe = await loadAst(app);
  const arr = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm);
  const out = await pipe(arr, { topk: 8 });
  return out.map((o) => ({ label: o.label, score: o.score }));
}

function cosine(a, b) {
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

module.exports = {
  embedImageFile,
  embedImageDataUrl,
  embedText,
  classifyAudio,
  cosine,
};
