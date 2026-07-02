import { useState } from "react";
import {
  FolderOpen,
  Calculator,
  MoreVertical,
  RefreshCw,
  Info,
  FileText,
  Layers,
} from "lucide-react";
import { useUiStore } from "@/stores/ui-store";
import { useDocumentStore } from "@/stores/document-store";
import { useOpenDocument } from "@/features/pdf/use-pdf-actions";
import { BatchDialog } from "@/features/pdf/BatchDialog";
import { checkForUpdates } from "@/hooks/use-updater";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./ThemeToggle";
import { SearchBar } from "./SearchBar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function TopBar() {
  const meta = useDocumentStore((s) => s.meta);
  const calculatorOpen = useUiStore((s) => s.calculatorOpen);
  const toggleCalculator = useUiStore((s) => s.toggleCalculator);
  const openDocument = useOpenDocument();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card px-3">
      {/* Brand */}
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-violet-500 shadow-sm">
          <FileText className="h-4 w-4 text-white" />
        </div>
        <span className="text-sm font-semibold tracking-tight">GoodBoyPdf</span>
      </div>

      {meta && (
        <>
          <span className="text-muted-foreground/40">/</span>
          <span className="max-w-[260px] truncate text-sm text-muted-foreground">
            {meta.title}
          </span>
        </>
      )}

      <div className="flex-1" />

      {meta && <SearchBar />}

      <Button variant="ghost" size="sm" onClick={() => void openDocument()}>
        <FolderOpen className="h-4 w-4" />
        Open
      </Button>

      <Button
        variant={calculatorOpen ? "default" : "ghost"}
        size="sm"
        onClick={toggleCalculator}
        className={cn(!calculatorOpen && "text-foreground")}
      >
        <Calculator className="h-4 w-4" />
        Calculator
      </Button>

      <ThemeToggle />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setBatchOpen(true)}>
            <Layers className="h-4 w-4" />
            Batch operations…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => checkForUpdates()}>
            <RefreshCw className="h-4 w-4" />
            Check for updates
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAboutOpen(true)}>
            <Info className="h-4 w-4" />
            About GoodBoyPdf
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BatchDialog open={batchOpen} onOpenChange={setBatchOpen} />

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent>
          <DialogHeader>
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-violet-500">
              <FileText className="h-6 w-6 text-white" />
            </div>
            <DialogTitle>GoodBoyPdf</DialogTitle>
            <DialogDescription>
              Version 1.0.0 · Produced by Goodboy Labs
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            A premium desktop PDF editor with high-fidelity rendering and an
            integrated Illinois mortgage & affordability calculator. Built with
            Tauri, React, and the PDFium engine.
          </p>
          <p className="text-xs text-muted-foreground">
            Mortgage tax and insurance figures are estimates based on Illinois
            averages and are not financial advice.
          </p>
          <p className="text-xs text-muted-foreground/70">
            © 2026 Goodboy Labs. All rights reserved.
          </p>
        </DialogContent>
      </Dialog>
    </header>
  );
}
