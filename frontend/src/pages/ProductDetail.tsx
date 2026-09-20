/**
 * One product: the reading, the strip chart, the settings, and the scrape log.
 *
 * The log is not collapsed and failures are not filtered out by default. This page exists
 * to answer "is this number trustworthy?", and you cannot answer that without seeing what
 * the scraper has been going through.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api, type HistoryRange, type LogRow, type Outcome, type TrackedRow } from '../lib/api';
import { StripChart } from '../components/StripChart';
import { DeltaBadge, ErrorPanel, Field, OutcomeDot, Panel, Skeleton, StockPill } from '../components/bits';
import {
  INTERVAL_CHOICES, OUTCOME_LABEL, STRATEGY_LABEL, delta, duration, explainError,
  money, stamp, timeAgo, timeUntil,
} from '../lib/format';

export function ProductDetail(): JSX.Element {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<HistoryRange>('7d');
  const [landingKey, setLandingKey] = useState<string | null>(null);

  const tracked = useQuery({ queryKey: ['tracked', id], queryFn: () => api.getTracked(id), enabled: Boolean(id) });
  const history = useQuery({
    queryKey: ['history', id, range],
    queryFn: () => api.history(id, range),
    enabled: Boolean(id),
    refetchInterval: 90_000,
  });

  const row = tracked.data?.tracked;
  const latestAt = history.data?.points.at(-1)?.t ?? null;
  const previousLatest = useRef<string | null>(null);

  // Mark a new reading arriving on the chart — a state change worth noticing, once.
  useEffect(() => {
    if (latestAt && previousLatest.current && latestAt !== previousLatest.current) {
      setLandingKey(latestAt);
      const timer = setTimeout(() => setLandingKey(null), 900);
      return () => clearTimeout(timer);
    }
    previousLatest.current = latestAt;
    return undefined;
  }, [latestAt]);

  const scrapeNow = useMutation({
    mutationFn: () => api.scrapeNow(id),
    onSuccess: (data) => {
      const r = data.result;
      if (r?.outcome === 'success') {
        toast.success(`${money(r.price, r.currency ?? 'INR')} · read via ${r.strategy ? STRATEGY_LABEL[r.strategy] : '—'} on attempt ${r.attempts}`);
      } else {
        toast.error(`Scrape failed after ${r?.attempts ?? 0} attempts — ${r?.errorCode ?? 'UNKNOWN'}. Nothing was stored.`);
      }
      void queryClient.invalidateQueries({ queryKey: ['history', id] });
      void queryClient.invalidateQueries({ queryKey: ['logs', id] });
      void queryClient.invalidateQueries({ queryKey: ['tracked'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Scrape failed to start'),
  });

  if (tracked.isPending) return <DetailSkeleton />;
  if (tracked.isError || !row) {
    return (
      <ErrorPanel
        title="Could not load this product"
        message={tracked.error instanceof Error ? tracked.error.message : 'It may have been untracked.'}
        onRetry={() => void tracked.refetch()}
      />
    );
  }

  const d24 = delta(row.latest_price, row.price_24h_ago);
  const d7 = delta(row.latest_price, row.price_7d_ago);
  const next = timeUntil(row.last_scraped_at, row.scrape_interval_minutes);

  return (
    <>
      <nav className="mb-4">
        <Link to="/" className="inline-flex min-h-[24px] items-center text-sm text-muted hover:text-ink">
          ‹ All tracked products
        </Link>
      </nav>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="font-display text-2xl leading-tight">{row.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {row.brand && <span>{row.brand}</span>}
            {row.category && <span className="border-l border-rule pl-2">{row.category}</span>}
            {row.sku && <span className="border-l border-rule pl-2 font-mono">{row.sku}</span>}
            <a
              href={row.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-[24px] items-center border-l border-rule pl-2 underline decoration-rule underline-offset-2 hover:decoration-ink"
            >
              View in the store
            </a>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => scrapeNow.mutate()}
            disabled={scrapeNow.isPending}
            aria-live="polite"
          >
            {scrapeNow.isPending ? 'Scraping…' : 'Scrape now'}
          </button>
        </div>
      </header>

      {scrapeNow.isPending && <LiveStatus />}

      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-5">
          {history.isPending ? (
            <Skeleton className="h-[300px] w-full" />
          ) : history.isError ? (
            <ErrorPanel
              title="Could not load the price history"
              message={history.error instanceof Error ? history.error.message : 'The request failed.'}
              onRetry={() => void history.refetch()}
            />
          ) : (
            <StripChart
              points={history.data.points}
              attempts={history.data.attempts}
              range={range}
              onRangeChange={setRange}
              intervalMinutes={row.scrape_interval_minutes}
              landingKey={landingKey}
            />
          )}

          <ScrapeLog trackedId={id} />
        </div>

        <aside className="space-y-5">
          {/* The reading. The one thing on this page that gets real size. */}
          <Panel className="p-4">
            <p className="label">Current reading</p>
            <p className="mt-1 font-display text-4xl leading-none tabular">
              {money(row.latest_price, row.latest_currency ?? 'INR')}
            </p>
            <p className="mt-1.5 text-sm text-muted">
              {row.latest_scraped_at ? `read ${timeAgo(row.latest_scraped_at)}` : 'no reading stored yet'}
            </p>

            <dl className="mt-4">
              <Field k="24 hours">
                <DeltaBadge value={d24} />
              </Field>
              <Field k="7 days">
                <DeltaBadge value={d7} />
              </Field>
              <Field k="Stock">
                <StockPill status={row.latest_stock_status} quantity={row.latest_stock_quantity} />
              </Field>
              {row.latest_mrp !== null && (
                <Field k="List price">
                  <span className="font-mono text-sm line-through decoration-rule">
                    {money(row.latest_mrp, row.latest_currency ?? 'INR')}
                  </span>
                </Field>
              )}
              <Field k="Readings">
                <span className="font-mono text-sm">{row.history_points}</span>
              </Field>
              <Field k="Next scrape">
                <span className="font-mono text-sm">{row.is_active ? (next ?? 'due now') : 'paused'}</span>
              </Field>
            </dl>

            {row.consecutive_failures >= 3 && (
              <p className="mt-3 border-l-2 border-l-rise pl-2.5 text-sm text-rise">
                {row.consecutive_failures} scrape cycles in a row have failed. The figure above is the last one that
                passed validation — it is not current.
              </p>
            )}
          </Panel>

          <Settings row={row} />
          <Metadata specs={row.specs} description={row.description} />
        </aside>
      </div>
    </>
  );
}

// --- settings ----------------------------------------------------------------

function Settings({ row }: { row: TrackedRow }): JSX.Element {
  const queryClient = useQueryClient();
  const [threshold, setThreshold] = useState(row.alert_price_below?.toString() ?? '');

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateTracked>[1]) => api.updateTracked(row.tracked_id, patch),
    onSuccess: () => {
      toast.success('Saved');
      void queryClient.invalidateQueries({ queryKey: ['tracked'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  });

  const untrack = useMutation({
    mutationFn: () => api.untrack(row.tracked_id),
    onSuccess: () => {
      toast.success('Stopped tracking');
      void queryClient.invalidateQueries({ queryKey: ['tracked'] });
      window.location.assign('/');
    },
  });

  return (
    <Panel title="Settings" className="p-0">
      <div className="space-y-4 p-4">
        <label className="block">
          <span className="label">Scrape frequency</span>
          <select
            className="field mt-1"
            value={row.scrape_interval_minutes}
            onChange={(e) => update.mutate({ scrapeIntervalMinutes: Number(e.target.value) })}
          >
            {INTERVAL_CHOICES.map((c) => (
              <option key={c.minutes} value={c.minutes}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted">
            The cron job fires every 2 hours; a product is scraped on the first run after its own interval elapses.
          </span>
        </label>

        <div>
          <span className="label">Alert when the price drops below</span>
          <div className="mt-1 flex gap-2">
            <input
              type="number"
              inputMode="numeric"
              className="field font-mono"
              placeholder="e.g. 120000"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-sm shrink-0"
              onClick={() => update.mutate({ alertPriceBelow: threshold === '' ? null : Number(threshold) })}
              disabled={update.isPending}
            >
              Save
            </button>
          </div>
        </div>

        {/* The whole label is the hit target, so the 16px box is not the activation area. */}
        <label className="flex min-h-[24px] cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-ink"
            checked={row.alert_on_restock}
            onChange={(e) => update.mutate({ alertOnRestock: e.target.checked })}
          />
          <span className="text-base">
            Alert when it comes back in stock
            <span className="block text-xs text-muted">Fires on the first reading after an out-of-stock one.</span>
          </span>
        </label>

        {/* The whole label is the hit target, so the 16px box is not the activation area. */}
        <label className="flex min-h-[24px] cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-ink"
            checked={row.is_active}
            onChange={(e) => update.mutate({ isActive: e.target.checked })}
          />
          <span className="text-base">
            Keep scraping
            <span className="block text-xs text-muted">Turning this off keeps the history and stops new readings.</span>
          </span>
        </label>
      </div>

      <footer className="border-t border-rule px-4 py-2.5">
        <button
          type="button"
          className="inline-flex min-h-[24px] items-center text-sm text-rise hover:underline"
          onClick={() => {
            if (window.confirm(`Stop tracking “${row.name}” and delete its price history? This cannot be undone.`)) {
              untrack.mutate();
            }
          }}
        >
          Untrack and delete history
        </button>
      </footer>
    </Panel>
  );
}

function Metadata({ specs, description }: { specs: Record<string, unknown> | null; description: string | null }): JSX.Element | null {
  const entries = Object.entries(specs ?? {});
  if (entries.length === 0 && !description) return null;

  const humanise = (k: string): string => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

  return (
    <Panel title="From the store" className="p-4">
      {description && <p className="mb-3 text-sm text-muted">{description}</p>}
      <dl>
        {entries.map(([k, v]) => (
          <Field key={k} k={humanise(k)}>
            <span className="text-sm">{String(v)}</span>
          </Field>
        ))}
      </dl>
    </Panel>
  );
}

// --- the scrape log ----------------------------------------------------------

const FILTERS: { value: Outcome | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'success', label: 'Success' },
  { value: 'retried', label: 'Retried' },
  { value: 'failed', label: 'Failed' },
];

function ScrapeLog({ trackedId }: { trackedId: string }): JSX.Element {
  const [filter, setFilter] = useState<Outcome | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const limit = 25;

  const logs = useQuery({
    queryKey: ['logs', trackedId, filter, offset],
    queryFn: () => api.logs(trackedId, { limit, offset, outcome: filter }),
    refetchInterval: 90_000,
  });

  const toggle = (id: number): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Panel
      title="Scrape log"
      action={
        <div role="group" aria-label="Filter by outcome" className="flex border border-rule">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => {
                setFilter(f.value);
                setOffset(0);
              }}
              aria-pressed={filter === f.value}
              className={`min-h-[24px] px-2.5 py-1 text-xs font-medium transition-colors duration-fast ${
                filter === f.value ? 'bg-ink text-paper' : 'bg-panel text-muted hover:bg-hover hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      {logs.isPending ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : logs.isError ? (
        <div className="p-4">
          <ErrorPanel
            title="Could not load the scrape log"
            message={logs.error instanceof Error ? logs.error.message : 'The request failed.'}
            onRetry={() => void logs.refetch()}
          />
        </div>
      ) : logs.data.logs.length === 0 ? (
        <p className="px-4 py-8 text-center text-base text-muted">
          {filter === 'all' ? 'No attempts recorded yet.' : `No ${filter} attempts in the log.`}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  <th className="px-3 py-1.5"><span className="label">Time</span></th>
                  <th className="px-3 py-1.5"><span className="label">#</span></th>
                  <th className="px-3 py-1.5"><span className="label">Outcome</span></th>
                  <th className="px-3 py-1.5"><span className="label">Strategy</span></th>
                  <th className="px-3 py-1.5 text-right"><span className="label">Took</span></th>
                  <th className="px-3 py-1.5 text-right"><span className="label">HTTP</span></th>
                  <th className="px-3 py-1.5"><span className="label">Detail</span></th>
                </tr>
              </thead>
              <tbody>
                {logs.data.logs.map((log) => (
                  <LogRowView key={log.id} log={log} expanded={expanded.has(log.id)} onToggle={() => toggle(log.id)} />
                ))}
              </tbody>
            </table>
          </div>

          <footer className="flex items-center justify-between border-t border-rule px-3 py-2">
            <span className="font-mono text-xs text-muted">
              {offset + 1}–{Math.min(offset + limit, logs.data.total)} of {logs.data.total}
            </span>
            <span className="flex gap-1">
              <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                Newer
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={offset + limit >= logs.data.total}
                onClick={() => setOffset(offset + limit)}
              >
                Older
              </button>
            </span>
          </footer>
        </>
      )}
    </Panel>
  );
}

function LogRowView({ log, expanded, onToggle }: { log: LogRow; expanded: boolean; onToggle: () => void }): JSX.Element {
  const hasDetail = Boolean(log.errorMessage || log.structureChanged || log.stockFound);
  return (
    <>
      <tr className="border-b border-rule last:border-b-0 hover:bg-sunken">
        <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">{stamp(log.startedAt)}</td>
        <td className="px-3 py-1.5 font-mono text-xs">{log.attempt}</td>
        <td className="px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-sm">
            <OutcomeDot outcome={log.outcome} size={9} />
            {OUTCOME_LABEL[log.outcome]}
          </span>
        </td>
        <td className="px-3 py-1.5 text-sm">{log.strategy ? STRATEGY_LABEL[log.strategy] : '—'}</td>
        <td className="px-3 py-1.5 text-right font-mono text-xs">{duration(log.durationMs)}</td>
        <td className="px-3 py-1.5 text-right font-mono text-xs">{log.httpStatus ?? '—'}</td>
        <td className="px-3 py-1.5">
          <span className="flex items-center gap-2">
            {log.errorCode ? (
              <span className="font-mono text-xs text-rise">{log.errorCode}</span>
            ) : log.priceFound !== null ? (
              <span className="font-mono text-xs">{money(log.priceFound)}</span>
            ) : (
              <span className="text-xs text-muted">—</span>
            )}
            {log.structureChanged && <span className="font-mono text-xs text-degraded">structure changed</span>}
            {hasDetail && (
              <button
                type="button"
                onClick={onToggle}
                aria-expanded={expanded}
                aria-label={expanded ? 'Hide the detail for this attempt' : 'Show why this attempt ended as it did'}
                className="ml-auto inline-flex min-h-[24px] min-w-[32px] items-center justify-center px-1 text-xs text-muted hover:text-ink"
              >
                {expanded ? 'hide' : 'why'}
              </button>
            )}
          </span>
        </td>
      </tr>
      {expanded && hasDetail && (
        <tr className="border-b border-rule bg-sunken">
          <td colSpan={7} className="px-3 py-2.5">
            {log.errorCode && <p className="text-sm">{explainError(log.errorCode)}</p>}
            {log.errorMessage && (
              <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words border border-rule bg-panel p-2 font-mono text-xs text-muted">
                {log.errorMessage}
              </pre>
            )}
            <p className="mt-1.5 font-mono text-xs text-muted">
              run {log.runId.slice(0, 8)}
              {log.stockFound ? ` · stock ${log.stockFound}` : ''}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

// --- misc --------------------------------------------------------------------

/**
 * A manual scrape runs the full engine: up to four attempts with backoff. That can take
 * 30 seconds against a store having a bad minute, so say what is happening rather than
 * leaving a button spinning.
 */
function LiveStatus(): JSX.Element {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="panel mb-5 border-l-2 border-l-degraded px-4 py-2.5" role="status" aria-live="polite">
      <p className="text-base">
        Running the scraper — up to 4 attempts with backoff, then validation.{' '}
        <span className="font-mono text-sm text-muted">{seconds}s</span>
      </p>
      <p className="mt-0.5 text-xs text-muted">
        If it fails, nothing is written and the log below will say why.
      </p>
    </div>
  );
}

function DetailSkeleton(): JSX.Element {
  return (
    <>
      <Skeleton className="mb-4 h-3.5 w-32" />
      <Skeleton className="mb-6 h-8 w-80" />
      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <Skeleton className="h-[300px] w-full" />
        <Skeleton className="h-[260px] w-full" />
      </div>
    </>
  );
}
