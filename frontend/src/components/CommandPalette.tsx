/**
 * Add a product: ⌘K / Ctrl-K, or the button on the dashboard.
 *
 * Search is debounced at 250 ms, results are fully keyboard-navigable, and tracking is
 * optimistic — the row shows "Tracking" the moment you press Enter, because the round trip
 * includes kicking off a first scrape and waiting for that would make the interaction feel
 * broken.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api, type SearchHit } from '../lib/api';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onTracked?: (trackedId: string) => void;
}

export function CommandPalette({ open, onClose, onTracked }: Props): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [justTracked, setJustTracked] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const queryClient = useQueryClient();
  const debounced = useDebounced(query.trim(), 250);

  const search = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.search(debounced),
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
  });

  const tracked = useQuery({ queryKey: ['tracked'], queryFn: api.listTracked, enabled: open });
  const alreadyTracking = useMemo(
    () => new Set((tracked.data?.tracked ?? []).map((t) => t.store_product_id)),
    [tracked.data],
  );

  const track = useMutation({
    mutationFn: (hit: SearchHit) => api.track(hit.storeProductId),
    onMutate: (hit) => {
      setJustTracked((prev) => new Set(prev).add(hit.storeProductId));
    },
    onSuccess: (data, hit) => {
      toast.success(`Tracking ${hit.name}. First scrape is running now.`);
      void queryClient.invalidateQueries({ queryKey: ['tracked'] });
      onTracked?.(data.tracked.tracked_id);
    },
    onError: (err, hit) => {
      setJustTracked((prev) => {
        const next = new Set(prev);
        next.delete(hit.storeProductId);
        return next;
      });
      toast.error(err instanceof Error ? err.message : 'Could not start tracking');
    },
  });

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setJustTracked(new Set());
      // Wait a frame so the dialog is in the DOM before focusing it.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setCursor(0), [debounced]);

  const results = useMemo(() => search.data?.results ?? [], [search.data]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((c) => Math.min(c + 1, Math.max(0, results.length - 1)));
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      }
      if (event.key === 'Enter') {
        const hit = results[cursor];
        if (hit && !alreadyTracking.has(hit.storeProductId) && !justTracked.has(hit.storeProductId)) {
          event.preventDefault();
          track.mutate(hit);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, results, cursor, alreadyTracking, justTracked, onClose, track]);

  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Find a product to track"
    >
      <button type="button" className="absolute inset-0 cursor-default bg-ink/35" aria-label="Close" onClick={onClose} />

      <div className="relative w-full max-w-xl bg-panel shadow-palette">
        <div className="flex items-center gap-3 border-b border-rule px-4">
          <SearchGlyph />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the store by name, brand or SKU…"
            className="w-full bg-transparent py-3.5 text-lg outline-none placeholder:text-muted"
            aria-label="Search the store"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden shrink-0 border border-rule px-1.5 py-0.5 font-mono text-xs text-muted sm:block">esc</kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto">
          {debounced.length < 2 ? (
            <Hint>Type at least two characters. Partial names work — try "slimbook", "nord" or "sleep tracker".</Hint>
          ) : search.isPending ? (
            <ul className="p-2">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="flex items-center gap-3 px-2 py-2.5">
                  <div className="skeleton h-3.5 w-1/3" />
                  <div className="skeleton h-3 w-16" />
                </li>
              ))}
            </ul>
          ) : search.isError ? (
            <Hint tone="error">
              {search.error instanceof Error ? search.error.message : 'The search request failed.'}
            </Hint>
          ) : results.length === 0 ? (
            <Hint>
              Nothing in the catalogue matches “{debounced}”.
              {search.data?.indexed !== undefined && (
                <span className="block pt-1 text-xs">
                  {search.data.indexed.toLocaleString('en-IN')} of the store's 1,000 products are indexed.
                </span>
              )}
            </Hint>
          ) : (
            <ul ref={listRef} role="listbox" aria-label="Search results" className="py-1">
              {results.map((hit, i) => {
                const isTracking = alreadyTracking.has(hit.storeProductId) || justTracked.has(hit.storeProductId);
                return (
                  <li key={hit.storeProductId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === cursor}
                      data-cursor={i === cursor}
                      disabled={isTracking}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => track.mutate(hit)}
                      className={`flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition-colors duration-fast ${
                        i === cursor ? 'bg-sunken' : ''
                      } ${isTracking ? 'cursor-default' : 'hover:bg-sunken'}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-base">{hit.name}</span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                          {hit.brand && <span>{hit.brand}</span>}
                          {hit.category && (
                            <span className="border-l border-rule pl-2" aria-hidden="true">
                              {hit.category}
                            </span>
                          )}
                          {hit.sku && <span className="border-l border-rule pl-2 font-mono">{hit.sku}</span>}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm">
                        {isTracking ? (
                          <span className="text-drop">Tracking</span>
                        ) : (
                          <span className={i === cursor ? 'text-ink' : 'text-muted'}>Track</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-rule px-4 py-2 text-xs text-muted">
          <span className="flex items-center gap-3">
            <Key>↑</Key>
            <Key>↓</Key>
            navigate
            <Key>↵</Key>
            track
          </span>
          {search.data?.source === 'live-sample' && <span className="text-degraded">sampling the live store</span>}
        </footer>
      </div>
    </div>
  );
}

function Hint({ children, tone = 'normal' }: { children: React.ReactNode; tone?: 'normal' | 'error' }): JSX.Element {
  return <p className={`px-4 py-6 text-base ${tone === 'error' ? 'text-rise' : 'text-muted'}`}>{children}</p>;
}

function Key({ children }: { children: React.ReactNode }): JSX.Element {
  return <kbd className="border border-rule px-1 font-mono text-xs">{children}</kbd>;
}

function SearchGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0 text-muted">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      <line x1="10.6" y1="10.6" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** ⌘K / Ctrl-K, registered once at the app root. */
export function usePaletteHotkey(onOpen: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpen]);
}
