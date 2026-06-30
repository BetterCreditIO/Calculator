import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { useToastStore, type ToastVariant } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const ICONS: Record<ToastVariant, typeof Info> = {
  default: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

const ACCENT: Record<ToastVariant, string> = {
  default: "text-primary",
  success: "text-emerald-500",
  error: "text-destructive",
};

/** Bottom-right toast stack. Mount once near the app root. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border bg-card p-3.5 shadow-lg animate-slide-in-right"
            role="status"
          >
            <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", ACCENT[t.variant])} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-card-foreground">
                {t.title}
              </p>
              {t.description && (
                <p className="mt-0.5 text-xs text-muted-foreground break-words">
                  {t.description}
                </p>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="rounded p-0.5 text-muted-foreground transition-smooth hover:bg-accent hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
