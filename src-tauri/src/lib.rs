//! GoodBoyPdf — Tauri application entry point (library half). Produced by Goodboy Labs.
//!
//! Wires up plugins, spawns the PDF engine as managed state, and registers the
//! command handlers. `main.rs` simply calls [`run`].

mod error;
mod pdf;

use pdf::engine::PdfEngine;

/// Build and run the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        // Structured logging to stdout (dev) and the OS log dir (release).
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init());

    // The auto-updater is desktop-only.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            // Resolve the resource directory (where the bundler installs
            // pdfium.dll) and hand it to the engine as its first lookup path.
            use tauri::Manager;
            let lib_dir = app.path().resource_dir().ok();
            app.manage(PdfEngine::spawn(lib_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pdf::commands::open_pdf,
            pdf::commands::open_pdf_bytes,
            pdf::commands::close_pdf,
            pdf::commands::render_page,
            pdf::commands::get_page_text,
            pdf::commands::search_text,
            pdf::commands::transform_pages,
            pdf::commands::write_text_file,
            pdf::commands::save_document,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the GoodBoyPdf application");
}
