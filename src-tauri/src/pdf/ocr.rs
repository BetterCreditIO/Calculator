//! OCR fallback for pages with no embedded text.
//!
//! "Print to PDF" drivers (notably Microsoft Print to PDF) and scanners often
//! produce pages that are pure raster images or vector outlines — zero fonts,
//! zero text operators. PDFium correctly finds no text there. To make such
//! documents selectable, searchable, and editable, the engine falls back to
//! optical character recognition on the rendered page.
//!
//! The recognizer is the **Windows built-in OCR engine** (`Windows.Media.Ocr`):
//! it ships with Windows 10/11, runs fully offline, respects the user's
//! installed languages, and costs nothing in installer size. On non-Windows
//! platforms recognition is unavailable and pages simply have no text layer
//! (the pre-OCR behavior).

/// One recognized word with its bounding box in BITMAP PIXELS.
pub struct OcrWordBox {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[cfg(windows)]
pub mod platform {
    use super::OcrWordBox;
    use crate::error::{PdfError, PdfResult};
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;

    /// Initialize the Windows Runtime on the calling thread. Called once from
    /// the engine worker before any recognition; repeated calls are harmless
    /// (RPC_E_CHANGED_MODE and S_FALSE are both ignored).
    pub fn init_thread() {
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
    }

    /// The engine's maximum supported image dimension (either axis).
    pub fn max_dimension() -> u32 {
        OcrEngine::MaxImageDimension().unwrap_or(2600)
    }

    /// Cheap availability probe, memoized: lets callers skip the expensive
    /// high-resolution page render entirely when no OCR engine exists for the
    /// user's languages.
    pub fn available() -> bool {
        static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *AVAILABLE.get_or_init(|| OcrEngine::TryCreateFromUserProfileLanguages().is_ok())
    }

    /// Recognize words in a BGRA8 bitmap. Returns `Ok(None)` when no OCR
    /// engine is available for the user's profile languages (rare; e.g. a
    /// stripped-down Windows without language OCR packs).
    pub fn recognize_words(
        bgra: &[u8],
        width: i32,
        height: i32,
    ) -> PdfResult<Option<Vec<OcrWordBox>>> {
        let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() else {
            return Ok(None);
        };

        let run = || -> windows::core::Result<Vec<OcrWordBox>> {
            let buffer = CryptographicBuffer::CreateFromByteArray(bgra)?;
            let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
                &buffer,
                BitmapPixelFormat::Bgra8,
                width,
                height,
            )?;
            let result = engine.RecognizeAsync(&bitmap)?.join()?;

            let mut words = Vec::new();
            for line in result.Lines()? {
                for word in line.Words()? {
                    let text = word.Text()?.to_string();
                    if text.trim().is_empty() {
                        continue;
                    }
                    let rect = word.BoundingRect()?;
                    words.push(OcrWordBox {
                        text,
                        x: rect.X,
                        y: rect.Y,
                        width: rect.Width,
                        height: rect.Height,
                    });
                }
            }
            Ok(words)
        };

        run()
            .map(Some)
            .map_err(|e| PdfError::Pdfium(format!("text recognition failed: {e}")))
    }
}

#[cfg(not(windows))]
pub mod platform {
    use super::OcrWordBox;
    use crate::error::PdfResult;

    pub fn init_thread() {}

    pub fn max_dimension() -> u32 {
        2600
    }

    pub fn available() -> bool {
        false
    }

    /// OCR is Windows-only; other platforms report "no engine available".
    pub fn recognize_words(
        _bgra: &[u8],
        _width: i32,
        _height: i32,
    ) -> PdfResult<Option<Vec<OcrWordBox>>> {
        Ok(None)
    }
}
