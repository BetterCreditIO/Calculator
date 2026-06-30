import { useEffect } from "react";
import { Loader2, UploadCloud } from "lucide-react";
import { useUiStore } from "@/stores/ui-store";
import { useDocumentStore } from "@/stores/document-store";
import { TopBar } from "@/components/layout/TopBar";
import { StatusBar } from "@/components/layout/StatusBar";
import { Toaster } from "@/components/ui/toaster";
import { PdfToolbar } from "@/features/pdf/PdfToolbar";
import { PdfViewer } from "@/features/pdf/PdfViewer";
import { EmptyState } from "@/features/pdf/EmptyState";
import { Thumbnails } from "@/features/pdf/Thumbnails";
import { MortgageCalculator } from "@/features/mortgage/MortgageCalculator";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useAutoUpdate } from "@/hooks/use-updater";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export default function App() {
  const meta = useDocumentStore((s) => s.meta);
  const status = useDocumentStore((s) => s.status);
  const error = useDocumentStore((s) => s.error);

  const thumbnailsOpen = useUiStore((s) => s.thumbnailsOpen);
  const calculatorOpen = useUiStore((s) => s.calculatorOpen);

  useKeyboardShortcuts();
  useAutoUpdate();
  const dragging = useFileDrop();

  // Surface document-open failures from the store.
  useEffect(() => {
    if (status === "error" && error) {
      toast.error("Couldn't open the document", error);
    }
  }, [status, error]);

  const showThumbnails = !!meta && thumbnailsOpen;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <TopBar />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Thumbnail sidebar */}
        <aside
          className={cn(
            "shrink-0 overflow-hidden border-r bg-card transition-[width] duration-300 ease-out",
            showThumbnails ? "w-[164px]" : "w-0",
          )}
        >
          <div className="h-full w-[164px]">
            <Thumbnails />
          </div>
        </aside>

        {/* Main document area */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {meta ? (
            <>
              <PdfToolbar />
              <div className="relative min-h-0 flex-1">
                <PdfViewer />
              </div>
            </>
          ) : status === "loading" ? (
            <LoadingScreen />
          ) : (
            <EmptyState />
          )}

          {dragging && <DropOverlay />}
        </main>

        {/* Calculator panel (docked, slide-in) */}
        <div
          className={cn(
            "shrink-0 overflow-hidden border-l bg-card transition-[width] duration-300 ease-out",
            calculatorOpen ? "w-[384px]" : "w-0",
          )}
        >
          <div className="h-full w-[384px]">
            <MortgageCalculator />
          </div>
        </div>
      </div>

      <StatusBar />
      <Toaster />
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="page-canvas-bg flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-sm">Opening document…</p>
    </div>
  );
}

function DropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-card/90 px-10 py-8 shadow-xl">
        <UploadCloud className="h-10 w-10 text-primary" />
        <p className="text-sm font-medium">Drop your PDF to open</p>
      </div>
    </div>
  );
}
