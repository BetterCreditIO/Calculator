import { FileText, Circle, CheckCircle2 } from "lucide-react";
import { useDocumentStore } from "@/stores/document-store";
import { useAnnotationStore } from "@/stores/annotation-store";
import { formatBytes } from "@/lib/utils";

/** Slim bottom status bar with document and edit-state info. */
export function StatusBar() {
  const meta = useDocumentStore((s) => s.meta);
  const currentPage = useDocumentStore((s) => s.currentPage);
  const scale = useDocumentStore((s) => s.scale);
  const dirty = useAnnotationStore((s) => s.dirty);
  const annotationCount = useAnnotationStore((s) => s.annotations.length);
  const editCount = useAnnotationStore((s) => s.edits.length);

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t bg-card px-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          {meta ? meta.title : "No document"}
        </span>
        {meta && (
          <span className="tabular-nums">
            Page {currentPage + 1} of {meta.pageCount}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {meta && (annotationCount > 0 || editCount > 0) && (
          <span>
            {annotationCount} markup{annotationCount === 1 ? "" : "s"}
            {editCount > 0 && `, ${editCount} edit${editCount === 1 ? "" : "s"}`}
          </span>
        )}
        {meta && (
          <span className="flex items-center gap-1">
            {dirty ? (
              <>
                <Circle className="h-2 w-2 fill-amber-500 text-amber-500" />
                Unsaved changes
              </>
            ) : (
              <>
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                Saved
              </>
            )}
          </span>
        )}
        {meta && (
          <span className="tabular-nums">{formatBytes(meta.fileSizeBytes)}</span>
        )}
        {meta && <span className="tabular-nums">{Math.round(scale * 100)}%</span>}
      </div>
    </footer>
  );
}
