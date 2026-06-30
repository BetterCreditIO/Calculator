import { FileText, FolderOpen, Calculator, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOpenDocument } from "./use-pdf-actions";
import { useUiStore } from "@/stores/ui-store";

/** Friendly first-run / no-document screen with a clear call to action. */
export function EmptyState() {
  const openDocument = useOpenDocument();
  const setCalculatorOpen = useUiStore((s) => s.setCalculatorOpen);

  return (
    <div className="page-canvas-bg flex h-full w-full items-center justify-center p-8">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-violet-500 shadow-lg">
          <FileText className="h-10 w-10 text-white" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">
          Open a PDF to get started
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          View, mark up, and edit documents with high-fidelity rendering. Drag a
          PDF anywhere onto this window, or open one below.
        </p>

        <div className="mt-6 flex items-center justify-center gap-3">
          <Button size="lg" onClick={() => void openDocument()}>
            <FolderOpen className="h-4 w-4" />
            Open PDF
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={() => setCalculatorOpen(true)}
          >
            <Calculator className="h-4 w-4" />
            Mortgage Calculator
          </Button>
        </div>

        <div className="mt-8 inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Tip: press <Kbd>Ctrl</Kbd>+<Kbd>O</Kbd> to open, <Kbd>Ctrl</Kbd>+
          <Kbd>M</Kbd> for the calculator
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border bg-muted px-1 font-mono text-[10px] font-medium text-foreground">
      {children}
    </kbd>
  );
}
