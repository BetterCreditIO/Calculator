/**
 * Native OS file drag-and-drop. Tauri delivers drop events (with real file
 * paths) through the webview API when `dragDropEnabled` is set on the window.
 * Returns whether a drag is currently hovering so the UI can show a drop hint.
 */
import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri";
import { useOpenPath } from "@/features/pdf/use-pdf-actions";

export function useFileDrop(): boolean {
  const openPath = useOpenPath();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let active = true;

    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over" || payload.type === "enter") {
          setDragging(true);
        } else if (payload.type === "leave") {
          setDragging(false);
        } else if (payload.type === "drop") {
          setDragging(false);
          const first = payload.paths?.find((p) =>
            p.toLowerCase().endsWith(".pdf"),
          );
          if (first) void openPath(first);
        }
      });
      if (active) unlisten = stop;
      else stop();
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [openPath]);

  return dragging;
}
