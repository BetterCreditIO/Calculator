/**
 * Batch operations dialog: pick many PDFs, choose one operation, run it.
 *
 * Two operations cover the daily "stack of loan documents" workflows:
 *   - ROTATE writes a rotated COPY of every file into a chosen folder
 *     (sources are never modified, existing files never overwritten);
 *   - MERGE concatenates the files, in list order, into one packet — the
 *     order controls (↑/↓) matter, so they're first-class in the row UI.
 *
 * The dialog stays open after a run to show the per-file report.
 */
import { useState } from "react";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  FilePlus2,
  Layers,
  Loader2,
  Trash2,
} from "lucide-react";
import { batchProcess, type BatchOp, type BatchReport } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type BatchKind = "rotate-cw" | "rotate-180" | "rotate-ccw" | "merge";

const KIND_LABELS: Record<BatchKind, string> = {
  "rotate-cw": "Rotate all pages 90° clockwise",
  "rotate-180": "Rotate all pages 180°",
  "rotate-ccw": "Rotate all pages 90° counter-clockwise",
  merge: "Merge into one PDF (in list order)",
};

const TURNS: Record<Exclude<BatchKind, "merge">, number> = {
  "rotate-cw": 1,
  "rotate-180": 2,
  "rotate-ccw": 3,
};

interface BatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BatchDialog({ open, onOpenChange }: BatchDialogProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [kind, setKind] = useState<BatchKind>("rotate-cw");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<BatchReport | null>(null);

  function handleOpenChange(next: boolean) {
    if (running) return; // don't close mid-run
    onOpenChange(next);
    if (!next) {
      setFiles([]);
      setReport(null);
    }
  }

  async function addFiles() {
    const selected = await openDialog({
      multiple: true,
      directory: false,
      filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
      title: "Add PDFs to the batch",
    });
    if (!selected) return;
    const additions = Array.isArray(selected) ? selected : [selected];
    setFiles((prev) => [...prev, ...additions.filter((f) => !prev.includes(f))]);
    setReport(null);
  }

  function move(index: number, delta: -1 | 1) {
    setFiles((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function run() {
    let op: BatchOp;
    if (kind === "merge") {
      const outputPath = await saveDialog({
        defaultPath: "merged.pdf",
        filters: [{ name: "PDF Document", extensions: ["pdf"] }],
        title: "Save merged PDF as",
      });
      if (!outputPath) return;
      op = { type: "merge", outputPath };
    } else {
      const outputDir = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose the output folder for rotated copies",
      });
      if (typeof outputDir !== "string") return;
      op = { type: "rotate", clockwiseTurns: TURNS[kind], outputDir };
    }

    setRunning(true);
    setReport(null);
    try {
      const result = await batchProcess(files, op);
      setReport(result);
      const ok = result.outputs.length;
      if (result.failures.length === 0) {
        toast.success(
          "Batch complete",
          kind === "merge"
            ? `Merged ${result.processed} files into one PDF.`
            : `Wrote ${ok} rotated ${ok === 1 ? "copy" : "copies"}.`,
        );
      } else {
        toast.error(
          "Batch finished with problems",
          `${result.failures.length} of ${result.processed} file(s) failed — details below.`,
        );
      }
    } catch (err) {
      toast.error(
        "Batch failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setRunning(false);
    }
  }

  const canRun =
    !running && (kind === "merge" ? files.length >= 2 : files.length >= 1);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Batch operations
          </DialogTitle>
          <DialogDescription>
            Apply one operation to many PDFs at once. Originals are never
            modified; outputs are always written as new files.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Select value={kind} onValueChange={(v) => setKind(v as BatchKind)}>
            <SelectTrigger aria-label="Batch operation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_LABELS) as BatchKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-1.5">
            {files.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No files yet — add the PDFs to process.
              </p>
            ) : (
              files.map((file, i) => (
                <div
                  key={file}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent/50"
                >
                  <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {i + 1}.
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={file}>
                    {baseName(file)}
                  </span>
                  {kind === "merge" && (
                    <>
                      <RowButton
                        label="Move up"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </RowButton>
                      <RowButton
                        label="Move down"
                        disabled={i === files.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </RowButton>
                    </>
                  )}
                  <RowButton
                    label="Remove"
                    onClick={() =>
                      setFiles((prev) => prev.filter((f) => f !== file))
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </RowButton>
                </div>
              ))
            )}
          </div>

          <Button variant="outline" size="sm" onClick={() => void addFiles()}>
            <FilePlus2 className="h-4 w-4" />
            Add files…
          </Button>

          {report && report.failures.length > 0 && (
            <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs">
              {report.failures.map((f) => (
                <p key={f.path} className="text-destructive">
                  <span className="font-medium">{baseName(f.path)}</span> —{" "}
                  {f.error}
                </p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={running}
          >
            Close
          </Button>
          <Button onClick={() => void run()} disabled={!canRun}>
            {running && <Loader2 className="h-4 w-4 animate-spin" />}
            {running
              ? "Processing…"
              : `Run on ${files.length} file${files.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground",
        "hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30",
      )}
    >
      {children}
    </button>
  );
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
