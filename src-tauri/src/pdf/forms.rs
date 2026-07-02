//! Interactive AcroForm support: field enumeration and form filling.
//!
//! ENUMERATION walks each page's widget annotations through pdfium-render's
//! safe wrapper and emits one [`FormField`] per widget, with bounds converted
//! into the app's display (top-left) point space via [`PageGeometry`].
//!
//! FILLING deliberately does NOT write field dictionaries directly (a bare
//! `/V` update leaves the widget's appearance stream stale, so Adobe, Chrome
//! and printers would keep showing the old value). Instead it drives pdfium's
//! own form-fill machinery over the raw `FORM_*` bindings — the same event
//! path a click or keystroke takes in Chrome's PDF viewer: focus the widget,
//! replace its text (or click it), then kill focus. Pdfium then regenerates
//! the widget appearance stream itself, honoring the field's authored font,
//! size and alignment, and toggles use the field's real export values. The
//! result displays correctly everywhere, not just in our renderer.
//!
//! The raw path owns its own document lifecycle (`FPDF_LoadMemDocument64` →
//! `FPDFDOC_InitFormFillEnvironment` → … → `FPDF_SaveAsCopy`), independent of
//! any safe-wrapper document, because pdfium-render keeps its raw handles
//! crate-private.

use std::collections::BTreeMap;
use std::os::raw::{c_int, c_ulong, c_void};

use pdfium_render::prelude::*;

use crate::error::{PdfError, PdfResult};
use crate::pdf::engine::PageGeometry;
use crate::pdf::models::{FormField, FormFieldKind, FormFieldValue};

// ===========================================================================
// Enumeration (safe wrapper)
// ===========================================================================

/// List every fillable form-field widget in the document, page by page.
/// Returns an empty list for documents without an interactive form.
pub fn list_form_fields(pdfium: &Pdfium, bytes: &[u8]) -> PdfResult<Vec<FormField>> {
    let document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
    if document.form().is_none() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for (page_index, page) in document.pages().iter().enumerate() {
        let geometry = PageGeometry::from_page(&page);
        for (annot_index, annotation) in page.annotations().iter().enumerate() {
            let Some(field) = annotation.as_form_field() else {
                continue;
            };
            let Some(info) = read_field(field) else {
                continue;
            };
            let Ok(bounds) = annotation.bounds() else {
                continue;
            };
            let bounds = geometry.rect_to_display(&bounds);
            // Hidden helper widgets have degenerate rects; they can't be
            // interacted with, so don't surface them.
            if bounds.width < 1.0 || bounds.height < 1.0 {
                continue;
            }
            out.push(FormField {
                page_index,
                annot_index,
                kind: info.kind,
                name: field.name(),
                bounds,
                value: info.value,
                checked: info.checked,
                options: info.options,
                read_only: field.is_read_only(),
                multiline: info.multiline,
                password: info.password,
                editable: info.editable,
            });
        }
    }

    // The safe wrapper misreports two states, so re-read them through the
    // real form API: its checkbox is_checked() assumes the on-state is
    // literally "/Yes" (real forms use "/On", "/1", export values …) and its
    // radio check compares two absent values as equal, reporting unselected
    // groups as checked. FPDFAnnot_IsChecked evaluates the actual appearance
    // state, and FPDFAnnot_GetFormFieldValue returns the live value (which
    // also recovers free text typed into editable combos).
    apply_raw_field_states(pdfium, bytes, &mut out);
    Ok(out)
}

/// Overwrite `checked` (toggles) and `value` (choice fields) with the states
/// reported by pdfium's form-fill API. Best-effort: on any failure the
/// safe-wrapper values stay in place rather than failing enumeration.
fn apply_raw_field_states(pdfium: &Pdfium, bytes: &[u8], fields: &mut [FormField]) {
    let mut by_page: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (i, field) in fields.iter().enumerate() {
        if matches!(
            field.kind,
            FormFieldKind::Checkbox
                | FormFieldKind::RadioButton
                | FormFieldKind::ComboBox
                | FormFieldKind::ListBox
        ) {
            by_page.entry(field.page_index).or_default().push(i);
        }
    }
    if by_page.is_empty() {
        return;
    }

    let bindings = pdfium.bindings();
    unsafe {
        let document = bindings.FPDF_LoadMemDocument64(bytes, None);
        if document.is_null() {
            return;
        }
        let mut form_info: FPDF_FORMFILLINFO = std::mem::zeroed();
        form_info.version = 1;
        let form = bindings.FPDFDOC_InitFormFillEnvironment(document, &mut form_info);
        if form.is_null() {
            bindings.FPDF_CloseDocument(document);
            return;
        }

        for (&page_index, indices) in &by_page {
            let page = bindings.FPDF_LoadPage(document, page_index as c_int);
            if page.is_null() {
                continue;
            }
            bindings.FORM_OnAfterLoadPage(page, form);
            for &i in indices {
                let field = &mut fields[i];
                let annot = bindings.FPDFPage_GetAnnot(page, field.annot_index as c_int);
                if annot.is_null() {
                    continue;
                }
                match field.kind {
                    FormFieldKind::Checkbox | FormFieldKind::RadioButton => {
                        field.checked = Some(bindings.FPDFAnnot_IsChecked(form, annot) != 0);
                    }
                    FormFieldKind::ComboBox | FormFieldKind::ListBox => {
                        if let Some(value) = read_form_field_value(bindings, form, annot) {
                            field.value = if value.is_empty() { None } else { Some(value) };
                        }
                    }
                    _ => {}
                }
                bindings.FPDFPage_CloseAnnot(annot);
            }
            bindings.FORM_OnBeforeClosePage(page, form);
            bindings.FPDF_ClosePage(page);
        }

        bindings.FPDFDOC_ExitFormFillEnvironment(form);
        bindings.FPDF_CloseDocument(document);
    }
}

/// Two-call read of FPDFAnnot_GetFormFieldValue (UTF-16LE, byte length
/// including the NUL terminator).
unsafe fn read_form_field_value(
    bindings: &dyn PdfiumLibraryBindings,
    form: FPDF_FORMHANDLE,
    annot: FPDF_ANNOTATION,
) -> Option<String> {
    let byte_len = bindings.FPDFAnnot_GetFormFieldValue(form, annot, std::ptr::null_mut(), 0);
    if byte_len < 2 {
        return None;
    }
    let mut buffer = vec![0u16; byte_len as usize / 2];
    bindings.FPDFAnnot_GetFormFieldValue(form, annot, buffer.as_mut_ptr(), byte_len);
    // Drop the trailing NUL before decoding.
    while buffer.last() == Some(&0) {
        buffer.pop();
    }
    Some(String::from_utf16_lossy(&buffer))
}

/// Type-specific properties of one field, gathered before assembly.
struct FieldInfo {
    kind: FormFieldKind,
    value: Option<String>,
    checked: Option<bool>,
    options: Vec<String>,
    multiline: bool,
    password: bool,
    editable: bool,
}

fn read_field(field: &PdfFormField) -> Option<FieldInfo> {
    if let Some(f) = field.as_text_field() {
        Some(FieldInfo {
            kind: FormFieldKind::Text,
            value: f.value(),
            checked: None,
            options: Vec::new(),
            multiline: f.is_multiline(),
            password: f.is_password(),
            editable: true,
        })
    } else if let Some(f) = field.as_checkbox_field() {
        Some(FieldInfo {
            kind: FormFieldKind::Checkbox,
            value: None,
            checked: Some(f.is_checked().unwrap_or(false)),
            options: Vec::new(),
            multiline: false,
            password: false,
            editable: false,
        })
    } else if let Some(f) = field.as_radio_button_field() {
        Some(FieldInfo {
            kind: FormFieldKind::RadioButton,
            value: None,
            checked: Some(f.is_checked().unwrap_or(false)),
            options: Vec::new(),
            multiline: false,
            password: false,
            editable: false,
        })
    } else if let Some(f) = field.as_combo_box_field() {
        Some(FieldInfo {
            kind: FormFieldKind::ComboBox,
            value: f.value(),
            checked: None,
            options: option_labels(f.options()),
            multiline: false,
            password: false,
            editable: f.has_editable_text_box(),
        })
    } else if let Some(f) = field.as_list_box_field() {
        Some(FieldInfo {
            kind: FormFieldKind::ListBox,
            value: f.value(),
            checked: None,
            options: option_labels(f.options()),
            multiline: false,
            password: false,
            editable: false,
        })
    } else if field.as_signature_field().is_some() {
        // Surfaced so the frontend can offer "place a signature here";
        // not fillable through this module.
        Some(FieldInfo {
            kind: FormFieldKind::Signature,
            value: None,
            checked: None,
            options: Vec::new(),
            multiline: false,
            password: false,
            editable: false,
        })
    } else {
        // Push buttons and unknown field types are not fillable.
        None
    }
}

fn option_labels(options: &PdfFormFieldOptions) -> Vec<String> {
    options
        .iter()
        .map(|o| o.label().cloned().unwrap_or_default())
        .collect()
}

// ===========================================================================
// Filling (raw form-fill machinery)
// ===========================================================================

/// Apply a batch of field values and return the document's replacement bytes.
///
/// Values are grouped by page so each page is loaded (and its form-fill state
/// initialized) exactly once. Any individual failure aborts the batch; the
/// caller keeps its original bytes, so a failed fill never corrupts the
/// document.
pub fn fill_form_fields(
    pdfium: &Pdfium,
    bytes: &[u8],
    values: &[FormFieldValue],
) -> PdfResult<Vec<u8>> {
    if values.is_empty() {
        return Ok(bytes.to_vec());
    }

    let mut by_page: BTreeMap<usize, Vec<&FormFieldValue>> = BTreeMap::new();
    for value in values {
        by_page.entry(value.page_index()).or_default().push(value);
    }

    let bindings = pdfium.bindings();
    unsafe {
        let document = bindings.FPDF_LoadMemDocument64(bytes, None);
        if document.is_null() {
            return Err(PdfError::Pdfium(
                "the document could not be parsed for form filling".into(),
            ));
        }

        // A zeroed FPDF_FORMFILLINFO (all callbacks null) is the standard
        // embedder setup for programmatic filling; pdfium null-checks every
        // callback before invoking it. The struct must outlive `form`.
        let mut form_info: FPDF_FORMFILLINFO = std::mem::zeroed();
        form_info.version = 1;
        let form = bindings.FPDFDOC_InitFormFillEnvironment(document, &mut form_info);
        if form.is_null() {
            bindings.FPDF_CloseDocument(document);
            return Err(PdfError::InvalidOperation(
                "this document has no interactive form".into(),
            ));
        }

        let mut result: PdfResult<()> = Ok(());
        for (&page_index, page_values) in &by_page {
            let page = bindings.FPDF_LoadPage(document, page_index as c_int);
            if page.is_null() {
                result = Err(PdfError::PageOutOfRange(page_index));
                break;
            }
            bindings.FORM_OnAfterLoadPage(page, form);

            for value in page_values {
                if let Err(e) = apply_one(bindings, form, page, value) {
                    result = Err(e);
                    break;
                }
            }

            // Commit any live editor state before releasing the page.
            bindings.FORM_ForceToKillFocus(form);
            bindings.FORM_OnBeforeClosePage(page, form);
            bindings.FPDF_ClosePage(page);
            if result.is_err() {
                break;
            }
        }

        let out = match result {
            Ok(()) => save_to_bytes(bindings, document),
            Err(e) => Err(e),
        };
        bindings.FPDFDOC_ExitFormFillEnvironment(form);
        bindings.FPDF_CloseDocument(document);
        out
    }
}

/// Apply a single field value through the form-fill event machinery.
unsafe fn apply_one(
    bindings: &dyn PdfiumLibraryBindings,
    form: FPDF_FORMHANDLE,
    page: FPDF_PAGE,
    value: &FormFieldValue,
) -> PdfResult<()> {
    let annot_index = value.annot_index();
    let annot = bindings.FPDFPage_GetAnnot(page, annot_index as c_int);
    if annot.is_null() {
        return Err(PdfError::InvalidOperation(format!(
            "form field widget {annot_index} was not found on the page"
        )));
    }

    // Commit and clear any focus left by a previous mutation FIRST: a click
    // dispatched while another widget still holds focus is consumed by that
    // widget's blur handling instead of toggling the target (confirmed
    // against real pdfium builds).
    bindings.FORM_ForceToKillFocus(form);

    let outcome = (|| -> PdfResult<()> {
        match value {
            FormFieldValue::Text { value, .. } => {
                if bindings.FORM_SetFocusedAnnot(form, annot) == 0 {
                    return Err(PdfError::InvalidOperation(
                        "the text field could not be focused for editing".into(),
                    ));
                }
                // Select-all + replace = full rewrite. Pdfium enforces the
                // field's MaxLen and regenerates the appearance stream on
                // focus loss, using the field's own default-appearance font.
                bindings.FORM_SelectAllText(form, page);
                let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
                bindings.FORM_ReplaceSelection(form, page, wide.as_ptr());
                bindings.FORM_ForceToKillFocus(form);
                Ok(())
            }
            FormFieldValue::Checkbox { checked, .. } => {
                let is_checked = bindings.FPDFAnnot_IsChecked(form, annot) != 0;
                if is_checked != *checked {
                    click_widget_center(bindings, form, page, annot)?;
                    if (bindings.FPDFAnnot_IsChecked(form, annot) != 0) != *checked {
                        return Err(PdfError::InvalidOperation(
                            "the checkbox did not toggle — it may be read-only".into(),
                        ));
                    }
                }
                Ok(())
            }
            FormFieldValue::Radio { .. } => {
                if bindings.FPDFAnnot_IsChecked(form, annot) == 0 {
                    click_widget_center(bindings, form, page, annot)?;
                    if bindings.FPDFAnnot_IsChecked(form, annot) == 0 {
                        return Err(PdfError::InvalidOperation(
                            "the option did not select — it may be read-only".into(),
                        ));
                    }
                }
                Ok(())
            }
            FormFieldValue::Choice { option_index, .. } => {
                if bindings.FORM_SetFocusedAnnot(form, annot) == 0 {
                    return Err(PdfError::InvalidOperation(
                        "the choice field could not be focused".into(),
                    ));
                }
                let ok =
                    bindings.FORM_SetIndexSelected(form, page, *option_index as c_int, 1);
                bindings.FORM_ForceToKillFocus(form);
                if ok == 0 {
                    return Err(PdfError::InvalidOperation(
                        "the option could not be selected".into(),
                    ));
                }
                Ok(())
            }
        }
    })();

    bindings.FPDFPage_CloseAnnot(annot);
    outcome
}

/// Simulate a primary-button click at the center of a widget — exactly what a
/// user click does in a pdfium-based viewer. Used to toggle checkboxes and
/// radio buttons so pdfium applies the group's REAL export values (`/On`,
/// `/1`, "Male", …) rather than assuming "Yes".
unsafe fn click_widget_center(
    bindings: &dyn PdfiumLibraryBindings,
    form: FPDF_FORMHANDLE,
    page: FPDF_PAGE,
    annot: FPDF_ANNOTATION,
) -> PdfResult<()> {
    let mut rect = FS_RECTF {
        left: 0.0,
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
    };
    if bindings.FPDFAnnot_GetRect(annot, &mut rect) == 0 {
        return Err(PdfError::InvalidOperation(
            "the widget's bounds could not be read".into(),
        ));
    }
    let x = f64::from((rect.left + rect.right) / 2.0);
    let y = f64::from((rect.top + rect.bottom) / 2.0);
    bindings.FORM_OnLButtonDown(form, page, 0, x, y);
    bindings.FORM_OnLButtonUp(form, page, 0, x, y);
    Ok(())
}

/// In-memory sink for `FPDF_SaveAsCopy`. `raw` MUST stay the first field:
/// pdfium hands the callback a pointer to it, and the callback casts that
/// pointer back to the containing struct.
#[repr(C)]
struct ByteSink {
    raw: FPDF_FILEWRITE,
    bytes: Vec<u8>,
}

unsafe extern "C" fn write_block(
    this: *mut FPDF_FILEWRITE,
    data: *const c_void,
    size: c_ulong,
) -> c_int {
    if this.is_null() || (data.is_null() && size > 0) {
        return 0;
    }
    let sink = &mut *(this as *mut ByteSink);
    if size > 0 {
        sink.bytes
            .extend_from_slice(std::slice::from_raw_parts(data as *const u8, size as usize));
    }
    1
}

unsafe fn save_to_bytes(
    bindings: &dyn PdfiumLibraryBindings,
    document: FPDF_DOCUMENT,
) -> PdfResult<Vec<u8>> {
    let mut sink = ByteSink {
        raw: FPDF_FILEWRITE {
            version: 1,
            WriteBlock: Some(write_block),
        },
        bytes: Vec::new(),
    };
    if bindings.FPDF_SaveAsCopy(document, &mut sink.raw, 0) == 0 {
        return Err(PdfError::Pdfium("saving the filled form failed".into()));
    }
    Ok(sink.bytes)
}
