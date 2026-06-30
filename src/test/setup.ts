import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia; the theme store and a few components
// probe it. Provide a minimal, inert stub so tests run headless.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
