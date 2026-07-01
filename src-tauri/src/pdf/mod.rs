//! PDF subsystem: the Pdfium-backed engine, its wire models, and the Tauri
//! command handlers that expose it to the frontend.

pub mod commands;
pub mod engine;
pub mod models;
pub mod ocr;
