/**
 * Document full-text search. Queries the backend, reports match count, and
 * navigates between hits (scrolling the viewport to each match's page).
 */
import { useEffect, useRef, useState } from "react";
import { Search, ChevronUp, ChevronDown, X, Loader2 } from "lucide-react";
import { searchText, type SearchHit } from "@/lib/tauri";
import { useDocumentStore } from "@/stores/document-store";
import { debounce } from "@/lib/utils";

export function SearchBar() {
  const meta = useDocumentStore((s) => s.meta);
  const requestScrollToPage = useDocumentStore((s) => s.requestScrollToPage);
  const setActiveSearchHit = useDocumentStore((s) => s.setActiveSearchHit);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  // Monotonic request id: a slow in-flight search must never clobber the
  // results of a newer query (or of a cleared box).
  const requestSeq = useRef(0);

  const runSearch = useRef(
    debounce(async (id: string, q: string) => {
      const seq = ++requestSeq.current;
      if (q.trim().length < 2) {
        setHits([]);
        setActiveSearchHit(null);
        setLoading(false);
        return;
      }
      try {
        const results = await searchText(id, q);
        if (seq !== requestSeq.current) return; // stale response — discard
        setHits(results);
        setIndex(0);
        const first = results[0] ?? null;
        setActiveSearchHit(first);
        if (first) requestScrollToPage(first.pageIndex);
      } catch {
        if (seq !== requestSeq.current) return;
        setHits([]);
        setActiveSearchHit(null);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, 300),
  );

  useEffect(() => {
    const fn = runSearch.current;
    return () => fn.cancel();
  }, []);

  // Reset when the document changes — including structural page operations
  // (rotate/delete/move/insert/append), which refresh `meta` under the SAME
  // id but invalidate every hit's pageIndex/spanIndex.
  useEffect(() => {
    setQuery("");
    setHits([]);
    setIndex(0);
  }, [meta]);

  if (!meta) return null;

  function onChange(value: string) {
    setQuery(value);
    setLoading(value.trim().length >= 2);
    runSearch.current(meta!.id, value);
  }

  function go(delta: number) {
    if (hits.length === 0) return;
    const next = (index + delta + hits.length) % hits.length;
    setIndex(next);
    const hit = hits[next];
    if (hit) {
      setActiveSearchHit(hit);
      requestScrollToPage(hit.pageIndex);
    }
  }

  return (
    <div className="flex h-8 items-center gap-1 rounded-md border border-input bg-background px-2 text-sm">
      <Search className="h-3.5 w-3.5 text-muted-foreground" />
      <input
        id="document-search-input"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") onChange("");
        }}
        placeholder="Search document…"
        className="w-40 bg-transparent outline-none placeholder:text-muted-foreground"
      />
      {loading && (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      )}
      {query.length >= 2 && !loading && (
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {hits.length === 0 ? "0/0" : `${index + 1}/${hits.length}`}
        </span>
      )}
      <div className="flex items-center">
        <button
          onClick={() => go(-1)}
          disabled={hits.length === 0}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
          aria-label="Previous match"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => go(1)}
          disabled={hits.length === 0}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
          aria-label="Next match"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        {query && (
          <button
            onClick={() => onChange("")}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
