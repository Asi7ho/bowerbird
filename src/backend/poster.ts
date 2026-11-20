// Video posters: one representative frame per video, saved as
// a JPEG next to the video in the board folder, so a video card
// can show a still image and only load the video itself when
// the user presses play. The capture runs in the renderer (it
// needs a <video> and a canvas); the file is stored through
// the same embedFileBytes bridge as dropped files. A poster is
// a bonus, never a blocker: every step returns null on
// failure and the caller keeps a placeholder instead.
import { api } from "./api";
import { posterNameFor, posterTime } from "./model";

// Capture one frame of a local video as a JPEG blob, plus its
// duration. Null when the video cannot be decoded or the frame
// cannot be read. The video is loaded with
// crossOrigin="anonymous": without it the app-file URL taints
// the canvas and toBlob throws — which is why the search
// indexer captures no video frames. app-file is registered
// corsEnabled, so the anonymous load succeeds.
async function captureVideoPoster(source: string): Promise<{ blob: Blob; duration: number } | null> {
  try {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.src = api.fileUrl(source);
    video.muted = true;
    video.preload = "auto";
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => resolve();
      setTimeout(resolve, 5000);
    });
    if (!isFinite(video.duration) || video.duration <= 0) return null;
    const duration = video.duration;
    video.currentTime = posterTime(duration);
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      setTimeout(resolve, 2000);
    });
    if (!video.videoWidth || !video.videoHeight) return null;
    const width = Math.min(640, video.videoWidth);
    const height = Math.round((width * video.videoHeight) / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    if (!blob) return null;
    return { blob, duration };
  } catch {
    return null;
  }
}

// Capture a video's poster and store it in the board folder.
// Returns the stored poster path and the duration, or null
// when the poster could not be made. The caller patches the
// item. Only for local videos: a remote link has no file to
// capture from.
export async function ensureVideoPoster(source: string): Promise<{ poster: string; duration: number } | null> {
  const captured = await captureVideoPoster(source);
  if (!captured) return null;
  try {
    const poster = await api.embedFileBytes(posterNameFor(source), await captured.blob.arrayBuffer());
    return { poster, duration: captured.duration };
  } catch {
    return null;
  }
}
