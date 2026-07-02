//! Folder-level batch operations.
//!
//! ROTATE processes each input independently and never touches the source
//! files: every output is written as a fresh "<name> (rotated).pdf" in the
//! chosen folder, with a numeric suffix if that name is taken — a batch can
//! never overwrite anything. Per-file failures are collected and reported;
//! the rest of the batch continues.
//!
//! MERGE concatenates the inputs, in selection order, into one new PDF. A
//! merge fails FAST on the first unreadable input (naming it) rather than
//! silently producing an incomplete packet — for loan files, a missing
//! disclosure is worse than no packet at all.

use std::path::{Path, PathBuf};

use pdfium_render::prelude::*;

use crate::error::{PdfError, PdfResult};
use crate::pdf::engine::{rotation_degrees, rotation_from_degrees};
use crate::pdf::models::{BatchFailure, BatchOp, BatchReport};

pub fn run_batch(pdfium: &Pdfium, inputs: &[String], op: &BatchOp) -> PdfResult<BatchReport> {
    if inputs.is_empty() {
        return Err(PdfError::InvalidOperation(
            "no input files were selected".into(),
        ));
    }
    match op {
        BatchOp::Rotate {
            clockwise_turns,
            output_dir,
        } => rotate_batch(pdfium, inputs, *clockwise_turns, output_dir),
        BatchOp::Merge { output_path } => merge_batch(pdfium, inputs, output_path),
    }
}

fn rotate_batch(
    pdfium: &Pdfium,
    inputs: &[String],
    clockwise_turns: u32,
    output_dir: &str,
) -> PdfResult<BatchReport> {
    let degrees = (clockwise_turns % 4) as i32 * 90;
    if degrees == 0 {
        return Err(PdfError::InvalidOperation(
            "a rotation of 0° would change nothing".into(),
        ));
    }
    let dir = Path::new(output_dir);
    if !dir.is_dir() {
        return Err(PdfError::InvalidOperation(
            "the output folder does not exist".into(),
        ));
    }

    let mut outputs = Vec::new();
    let mut failures = Vec::new();
    for input in inputs {
        match rotate_one(pdfium, input, degrees, dir) {
            Ok(path) => outputs.push(path),
            Err(e) => failures.push(BatchFailure {
                path: input.clone(),
                error: e.to_string(),
            }),
        }
    }
    Ok(BatchReport {
        processed: inputs.len(),
        outputs,
        failures,
    })
}

fn rotate_one(pdfium: &Pdfium, input: &str, degrees: i32, dir: &Path) -> PdfResult<String> {
    let bytes = std::fs::read(input).map_err(PdfError::from)?;
    let document = pdfium.load_pdf_from_byte_slice(&bytes, None)?;
    // Walk by index with explicit error propagation — a silently shortened
    // iteration would write a partially rotated file, which is worse than
    // failing the file outright.
    let pages = document.pages();
    for index in 0..pages.len() {
        let mut page = pages.get(index).map_err(|_| {
            PdfError::Pdfium(format!("page {} could not be read", index + 1))
        })?;
        let next = rotation_degrees(&page) + degrees;
        page.set_rotation(rotation_from_degrees(next));
    }

    let stem = Path::new(input)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let output = unique_output_path(dir, &format!("{stem} (rotated)"));
    document.save_to_file(&output)?;
    Ok(output.to_string_lossy().into_owned())
}

fn merge_batch(pdfium: &Pdfium, inputs: &[String], output_path: &str) -> PdfResult<BatchReport> {
    if inputs.len() < 2 {
        return Err(PdfError::InvalidOperation(
            "select at least two PDFs to merge".into(),
        ));
    }

    let with_file = |input: &str, e: PdfError| {
        PdfError::InvalidOperation(format!("{}: {e}", display_name(input)))
    };

    // The first input is the packet base; the rest append in order.
    let first_bytes = std::fs::read(&inputs[0])
        .map_err(|e| with_file(&inputs[0], PdfError::from(e)))?;
    let mut document = pdfium
        .load_pdf_from_byte_slice(&first_bytes, None)
        .map_err(|e| with_file(&inputs[0], PdfError::from(e)))?;

    for input in &inputs[1..] {
        let other_bytes =
            std::fs::read(input).map_err(|e| with_file(input, PdfError::from(e)))?;
        let other = pdfium
            .load_pdf_from_byte_slice(&other_bytes, None)
            .map_err(|e| with_file(input, PdfError::from(e)))?;
        document
            .pages_mut()
            .append(&other)
            .map_err(|e| with_file(input, PdfError::from(e)))?;
    }

    document.save_to_file(output_path)?;
    Ok(BatchReport {
        processed: inputs.len(),
        outputs: vec![output_path.to_string()],
        failures: Vec::new(),
    })
}

/// First non-existing "`name`.pdf" / "`name` 2.pdf" / … path in `dir`, so a
/// batch can never overwrite an existing file (including its own inputs).
fn unique_output_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(format!("{name}.pdf"));
    if !candidate.exists() {
        return candidate;
    }
    for n in 2.. {
        let candidate = dir.join(format!("{name} {n}.pdf"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("the counter loop above always returns");
}

fn display_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}
