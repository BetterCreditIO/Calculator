import { useEffect, useRef, useState } from "react";

/**
 * Track whether an element is within (or near) the viewport. Used to lazily
 * render PDF pages: only pages close to the scroll position fetch their raster,
 * which keeps large documents smooth and memory bounded while reserving layout
 * space for off-screen pages so the scrollbar stays accurate.
 */
export function useInView<T extends HTMLElement>(
  rootMargin = "800px",
): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setInView(entry.isIntersecting);
      },
      { root: null, rootMargin, threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  return [ref, inView];
}
