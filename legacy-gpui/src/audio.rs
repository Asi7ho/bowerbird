//! In-app audio playback, backed by rodio.
//!
//! The player is created lazily: opening the output device can fail on a
//! machine with no audio hardware (a headless VM, for instance), and that
//! must surface as a plain status message, never a crash. Decoding is kept
//! separate so it can be probed in tests without any device at all.

use crate::model::ItemId;
use rodio::{Decoder, OutputStream, OutputStreamBuilder, Sink};
use std::fs::File;
use std::io::{Read, Seek};

/// True when `source` decodes as audio. Used by tests and by nothing else
/// at runtime — playback itself reports decoder errors when you press play.
pub fn can_decode<R: Read + Seek + Send + Sync + 'static>(source: R) -> bool {
    Decoder::new(source).is_ok()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Playback {
    Stopped,
    Playing,
    Paused,
}

pub struct AudioPlayer {
    stream: Option<OutputStream>,
    sink: Option<Sink>,
    pub playing: Option<ItemId>,
}

impl Default for AudioPlayer {
    fn default() -> Self {
        Self {
            stream: None,
            sink: None,
            playing: None,
        }
    }
}

impl AudioPlayer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> Playback {
        match &self.sink {
            Some(sink) if !sink.empty() => {
                if sink.is_paused() {
                    Playback::Paused
                } else {
                    Playback::Playing
                }
            }
            _ => Playback::Stopped,
        }
    }

    /// Play `path` for `id`, or pause/resume it when it is already the
    /// playing item. Starting a different item stops the current one.
    pub fn toggle(&mut self, id: ItemId, path: &str) -> Result<Playback, String> {
        if self.playing == Some(id) {
            if let Some(sink) = &self.sink {
                if sink.is_paused() {
                    sink.play();
                    return Ok(Playback::Playing);
                }
                if !sink.empty() {
                    sink.pause();
                    return Ok(Playback::Paused);
                }
            }
        }
        self.start(id, path)
    }

    pub fn stop(&mut self) {
        if let Some(sink) = &self.sink {
            sink.stop();
        }
        self.playing = None;
    }

    fn ensure_stream(&mut self) -> Result<(), String> {
        if self.stream.is_none() {
            let stream = OutputStreamBuilder::open_default_stream()
                .map_err(|e| format!("No audio device available ({})", e))?;
            self.stream = Some(stream);
        }
        Ok(())
    }

    fn start(&mut self, id: ItemId, path: &str) -> Result<Playback, String> {
        self.ensure_stream()?;
        if let Some(sink) = &self.sink {
            sink.stop();
        }
        let sink = Sink::connect_new(self.stream.as_ref().unwrap().mixer());
        let file = File::open(path).map_err(|e| format!("Could not open {} ({})", path, e))?;
        let source =
            Decoder::new(file).map_err(|e| format!("Could not decode {} ({})", path, e))?;
        sink.append(source);
        sink.play();
        self.sink = Some(sink);
        self.playing = Some(id);
        Ok(Playback::Playing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A tiny valid WAV (44-byte header + a few 16-bit mono samples).
    fn wav_bytes() -> Vec<u8> {
        let mut v = Vec::new();
        let data: Vec<i16> = vec![0, 8000, 0, -8000, 0, 8000];
        let byte_len = (data.len() * 2) as u32;
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + byte_len).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&44100u32.to_le_bytes());
        v.extend_from_slice(&88200u32.to_le_bytes());
        v.extend_from_slice(&2u16.to_le_bytes());
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&byte_len.to_le_bytes());
        for s in data {
            v.extend_from_slice(&s.to_le_bytes());
        }
        v
    }

    #[test]
    fn decodes_a_wav_and_rejects_garbage() {
        assert!(can_decode(Cursor::new(wav_bytes())));
        assert!(!can_decode(Cursor::new(b"this is not audio".to_vec())));
    }
}
