//! Unified error type for the PDF backend.
//!
//! Every Tauri command returns `Result<T, PdfError>`. `PdfError` serializes to
//! a plain string (its `Display`) so the frontend's `BackendError` receives a
//! clean, human-readable message rather than an opaque object.

use serde::{Serialize, Serializer};

/// All failures that can surface from the PDF engine and commands.
#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    /// The Pdfium dynamic library could not be located or loaded. This is the
    /// one error users are most likely to hit on a broken install, so its
    /// message is actionable.
    #[error(
        "The PDF engine could not start: the Pdfium library (pdfium.dll) was \
         not found. Reinstall the application, or place pdfium.dll next to the \
         executable."
    )]
    EngineUnavailable,

    /// A document id was referenced that the backend does not have open.
    #[error("That document is no longer open. Please reopen the file.")]
    DocumentNotFound,

    /// The requested page index is out of range for the document.
    #[error("Page {0} does not exist in this document.")]
    PageOutOfRange(usize),

    /// A structurally invalid page operation (e.g. deleting the only page).
    #[error("{0}")]
    InvalidOperation(String),

    /// Wrapper around any error raised by pdfium-render.
    #[error("PDF processing failed: {0}")]
    Pdfium(String),

    /// Filesystem / IO failure.
    #[error("File error: {0}")]
    Io(String),

    /// Image encoding failure when producing the PNG raster.
    #[error("Could not render the page image: {0}")]
    Encode(String),

    /// The internal engine worker thread stopped unexpectedly.
    #[error("The PDF engine stopped responding. Please restart the app.")]
    EngineStopped,
}

impl From<std::io::Error> for PdfError {
    fn from(e: std::io::Error) -> Self {
        PdfError::Io(e.to_string())
    }
}

impl From<pdfium_render::prelude::PdfiumError> for PdfError {
    fn from(e: pdfium_render::prelude::PdfiumError) -> Self {
        PdfError::Pdfium(e.to_string())
    }
}

impl From<image::ImageError> for PdfError {
    fn from(e: image::ImageError) -> Self {
        PdfError::Encode(e.to_string())
    }
}

// Serialize as the Display string so the JS side gets a readable message.
impl Serialize for PdfError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convenience alias used throughout the backend.
pub type PdfResult<T> = Result<T, PdfError>;
