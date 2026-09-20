/**
 * The dashboard.
 *
 * One row per tracked product: the current reading, what it has done over 24h and 7d, a
 * sparkline, the outcome of the last scrape attempt, and when the next one is due. Sortable.
 *
 * The last-outcome column is not decorative. A product whose price looks fine but whose
 * last three scrapes failed is showing you a stale number, and this is where you find that
 * out at a glance.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type TrackedRow } from '../lib/api';
import { DeltaBadge, ErrorPanel, OutcomeDot, Skeleton, Sparkline, StockPill } from '../components/bits';
import { delta, explainError, intervalLabel, money, timeAgo, timeUntil } from '../lib/format';

type SortKey = 'name' | 'price' | 'delta24' | 'delta7' | 'lastScrape';

export function Dashboard({ onOpenPalette }: { onOpenPalette: () => void }): JSX.Element {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'lastScrape', dir: 'desc' });
  const tracked = useQuery({ queryKey: ['tracked'], queryFn: api.listTracked, refetchInterval: 60_000 });
  const structure = useQuery({ queryKey: ['structure'], queryFn: api.structure, refetchInterval: 300_000, retry: 0 });

  const rows = useMemo(() => {
    const list = [...(tracked.data?.tracked ?? [])];
    const dir = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sort.key) {
        case 'name':
          return a.name.localeCompare(b.name) * dir;
        case 'price':
          return ((a.latest_price ?? -1) - (b.latest_price ?? -1)) * dir;
        case 'delta24':
          return ((delta(a.latest_price, a.price_24h_ago)?.pct ?? 0) - (delta(b.latest_price, b.price_24h_ago)?.pct ?? 0)) * dir;
        case 'delta7':
          return ((delta(a.latest_price, a.price_7d_ago)?.pct ?? 0) - (delta(b.latest_price, b.price_7d_ago)?.pct ?? 0)) * dir;
        case 'lastScrape':
        default:
          return (Date.parse(a.last_scraped_at ?? '0') - Date.parse(b.last_scraped_at ?? '0')) * dir;
      }
    });
    return list;
  }, [tracked.data, sort]);

  const failing = rows.filter((r) => r.consecutive_failures >= 3);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl leading-none">Tracked products</h1>
          <p className="mt-1.5 text-base text-muted">
            Scraped from the INE mock store. Failures are shown, not hidden.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onOpenPalette}>
          Track a product
        </button>
      </header>

      {structure.data?.changedRecently && (
        <Banner tone="degraded">
          The store changed the shape of its price area recently. Extraction adapted and readings are still being
          validated — the scrape log records which attempts saw the change.
        </Banner>
      )}

      {failing.length > 0 && (
        <Banner tone="rise">
          {failing.length === 1
            ? `“${failing[0]?.name}” has failed ${failing[0]?.consecutive_failures} scrape cycles in a row.`
            : `${failing.length} products have failed three or more scrape cycles in a row.`}{' '}
          Their last stored price is still shown, but it is not current.
        </Banner>
      )}

      {tracked.isPending ? (
        <TableSkeleton />
      ) : tracked.isError ? (
        <ErrorPanel
          title="Could not load your tracked products"
          message={tracked.error instanceof Error ? tracked.error.message : 'The request failed.'}
          onRetry={() => void tracked.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState onOpenPalette={onOpenPalette} />
      ) : (
        <>
        <RunHealth rows={rows} />

        {/* Below lg the table becomes a list of cards. Eight columns need about 900px to
            breathe, and a table that scrolls sideways hides exactly the columns that matter
            most here — the outcome and the deltas live at the right-hand end. Between lg and
            xl the two least load-bearing columns drop out instead. */}
        <ul className="space-y-2 lg:hidden">
          {rows.map((row) => (
            <li key={row.tracked_id}>
              <Card row={row} />
            </li>
          ))}
        </ul>

        <div className="panel hidden overflow-x-auto lg:block">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="border-b border-rule">
                <Th sort={sort} setSort={setSort} col="name" className="w-[30%]">
                  Product
                </Th>
                <Th sort={sort} setSort={setSort} col="price" align="right">
                  Reading
                </Th>
                <Th sort={sort} setSort={setSort} col="delta24" align="right">
                  24h
                </Th>
                <Th sort={sort} setSort={setSort} col="delta7" align="right">
                  7d
                </Th>
                <th className="hidden px-3 py-2 xl:table-cell">
                  <span className="label">7-day trace</span>
                </th>
                <th className="px-3 py-2">
                  <span className="label">Stock</span>
                </th>
                <Th sort={sort} setSort={setSort} col="lastScrape">
                  Last scrape
                </Th>
                <th className="hidden px-3 py-2 xl:table-cell">
                  <span className="label">Next</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={row.tracked_id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {rows.length > 0 && <Footnote rows={rows} />}
    </>
  );
}

function Row({ row }: { row: TrackedRow }): JSX.Element {
  const d24 = delta(row.latest_price, row.price_24h_ago);
  const d7 = delta(row.latest_price, row.price_7d_ago);
  const next = timeUntil(row.last_scraped_at, row.scrape_interval_minutes);
  const stale = row.consecutive_failures >= 3;

  return (
    <tr className="group border-b border-rule last:border-b-0 hover:bg-sunken">
      <td className="px-3 py-2.5">
        <Link to={`/p/${row.tracked_id}`} className="block min-w-0">
          <span className="block truncate font-display text-lg leading-tight group-hover:underline">{row.name}</span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
            {row.brand && <span>{row.brand}</span>}
            {row.sku && <span className="border-l border-rule pl-2 font-mono">{row.sku}</span>}
            {!row.is_active && <span className="border-l border-rule pl-2 text-rise">paused</span>}
          </span>
        </Link>
      </td>

      <td className="px-3 py-2.5 text-right">
        <span className={`font-mono text-base ${stale ? 'text-muted' : ''}`}>
          {money(row.latest_price, row.latest_currency ?? 'INR')}
        </span>
        {stale && <span className="block text-xs text-degraded">may be stale</span>}
      </td>

      <td className="px-3 py-2.5 text-right">
        <DeltaBadge value={d24} />
      </td>
      <td className="px-3 py-2.5 text-right">
        <DeltaBadge value={d7} />
      </td>

      <td className="hidden px-3 py-2.5 xl:table-cell">
        <Sparkline points={row.sparkline} intervalMinutes={row.scrape_interval_minutes} />
      </td>

      <td className="px-3 py-2.5">
        <StockPill status={row.latest_stock_status} quantity={row.latest_stock_quantity} />
      </td>

      <td className="px-3 py-2.5">
        <span className="flex items-center gap-2">
          <OutcomeDot outcome={row.last_outcome} />
          <span className="text-sm">{timeAgo(row.last_scraped_at)}</span>
        </span>
        {row.last_error_code && (
          <span className="mt-0.5 block font-mono text-xs text-rise" title={explainError(row.last_error_code)}>
            {row.last_error_code}
          </span>
        )}
      </td>

      <td className="hidden px-3 py-2.5 xl:table-cell">
        <span className="font-mono text-sm text-muted">{row.is_active ? (next ?? 'due') : '—'}</span>
        <span className="mt-0.5 block text-xs text-muted">{intervalLabel(row.scrape_interval_minutes)}</span>
      </td>
    </tr>
  );
}

/** The same row, stacked, for phones. */
function Card({ row }: { row: TrackedRow }): JSX.Element {
  const d24 = delta(row.latest_price, row.price_24h_ago);
  const d7 = delta(row.latest_price, row.price_7d_ago);
  const next = timeUntil(row.last_scraped_at, row.scrape_interval_minutes);
  const stale = row.consecutive_failures >= 3;

  return (
    <Link to={`/p/${row.tracked_id}`} className="panel block p-3.5 hover:bg-sunken">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block truncate font-display text-lg leading-tight">{row.name}</span>
          <span className="mt-0.5 flex items-center gap-2 text-xs text-muted">
            {row.brand && <span>{row.brand}</span>}
            {row.sku && <span className="border-l border-rule pl-2 font-mono">{row.sku}</span>}
            {!row.is_active && <span className="border-l border-rule pl-2 text-rise">paused</span>}
          </span>
        </div>
        <span className="shrink-0 text-right">
          <span className={`block font-mono text-lg ${stale ? 'text-muted' : ''}`}>
            {money(row.latest_price, row.latest_currency ?? 'INR')}
          </span>
          {stale && <span className="block text-xs text-degraded">may be stale</span>}
        </span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <dl className="flex gap-4 text-xs">
          <div>
            <dt className="label">24h</dt>
            <dd>
              <DeltaBadge value={d24} />
            </dd>
          </div>
          <div>
            <dt className="label">7d</dt>
            <dd>
              <DeltaBadge value={d7} />
            </dd>
          </div>
          <div>
            <dt className="label">Stock</dt>
            <dd>
              <StockPill status={row.latest_stock_status} quantity={row.latest_stock_quantity} />
            </dd>
          </div>
        </dl>
        <Sparkline points={row.sparkline} intervalMinutes={row.scrape_interval_minutes} width={88} height={24} />
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-rule pt-2 text-xs">
        <span className="flex items-center gap-1.5">
          <OutcomeDot outcome={row.last_outcome} size={9} />
          <span className="text-muted">{timeAgo(row.last_scraped_at)}</span>
          {row.last_error_code && <span className="font-mono text-rise">{row.last_error_code}</span>}
        </span>
        <span className="font-mono text-muted">{row.is_active ? `next ${next ?? 'due'}` : '—'}</span>
      </div>
    </Link>
  );
}

/**
 * Run health.
 *
 * The one number that answers "is this thing still working?" — the share of attempts in
 * the last 24 hours that produced a stored reading — next to when the scheduler last fired.
 * Both are read from data already on the page, so it costs no extra request.
 */
function RunHealth({ rows }: { rows: TrackedRow[] }): JSX.Element {
  const runs = useQuery({ queryKey: ['runs'], queryFn: api.runs, refetchInterval: 120_000, retry: 0 });
  const lastRun = runs.data?.runs?.[0] ?? null;

  const active = rows.filter((r) => r.is_active);
  const succeeding = active.filter((r) => r.last_outcome === 'success').length;
  const readings = rows.reduce((n, r) => n + r.history_points, 0);
  const dueSoon = active
    .map((r) => timeUntil(r.last_scraped_at, r.scrape_interval_minutes))
    .filter((v): v is string => v !== null)
    .sort()[0];

  return (
    <dl className="mb-4 grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
      <Stat
        k="Last run"
        v={lastRun ? timeAgo(lastRun.started_at) : '—'}
        sub={lastRun ? `${lastRun.products_succeeded}/${lastRun.products_attempted} succeeded` : 'no run recorded yet'}
      />
      <Stat
        k="Products reporting"
        v={`${succeeding}/${active.length}`}
        sub={succeeding === active.length ? 'all current' : `${active.length - succeeding} not current`}
        tone={succeeding === active.length ? 'ok' : 'warn'}
      />
      <Stat k="Readings stored" v={readings.toLocaleString('en-IN')} sub="validated, never guessed" />
      <Stat k="Next scrape" v={dueSoon ?? 'due now'} sub={runs.isError ? 'scheduler unreachable' : 'per-product interval'} />
    </dl>
  );
}

function Stat({ k, v, sub, tone }: { k: string; v: string; sub: string; tone?: 'ok' | 'warn' }): JSX.Element {
  return (
    <div className="bg-panel px-3.5 py-2.5">
      <dt className="label">{k}</dt>
      <dd
        className="font-mono text-lg leading-tight"
        style={{ color: tone === 'warn' ? '#8A6A1F' : undefined }}
      >
        {v}
      </dd>
      <p className="text-xs text-muted">{sub}</p>
    </div>
  );
}

function Th({
  col,
  sort,
  setSort,
  children,
  align = 'left',
  className = '',
}: {
  col: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  setSort: (s: { key: SortKey; dir: 'asc' | 'desc' }) => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}): JSX.Element {
  const active = sort.key === col;
  return (
    <th className={`px-3 py-2 ${className}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => setSort({ key: col, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}
        className={`label inline-flex min-h-[24px] items-center gap-1.5 py-0.5 hover:text-ink ${
          align === 'right' ? 'w-full justify-end' : ''
        } ${active ? 'text-ink' : ''}`}
      >
        {children}
        {/* Fixed width so the column heading does not shift when the sort moves. */}
        <span aria-hidden="true" className="inline-block w-2 text-center font-mono text-[9px] leading-none">
          {active ? (sort.dir === 'desc' ? '▼' : '▲') : '·'}
        </span>
      </button>
    </th>
  );
}

function Banner({ tone, children }: { tone: 'degraded' | 'rise'; children: React.ReactNode }): JSX.Element {
  return (
    <div
      role="status"
      className={`panel mb-4 border-l-2 px-4 py-2.5 text-base ${tone === 'rise' ? 'border-l-rise' : 'border-l-degraded'}`}
    >
      {children}
    </div>
  );
}

/** An invitation with the search in it, not a shrug. */
function EmptyState({ onOpenPalette }: { onOpenPalette: () => void }): JSX.Element {
  const status = useQuery({ queryKey: ['index-status'], queryFn: api.indexStatus, retry: 0 });

  return (
    <div className="panel px-6 py-14 text-center">
      <svg width="200" height="58" viewBox="0 0 200 58" className="mx-auto" aria-hidden="true">
        <line x1="0" y1="45" x2="200" y2="45" stroke="#C6CBD1" strokeWidth="1" />
        <path d="M4 34 L34 34 L52 18 L76 40 L96 26 L120 30" fill="none" stroke="#C6CBD1" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M140 24 L164 30 L196 14" fill="none" stroke="#131A22" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="120" y1="30" x2="140" y2="24" stroke="#8892A0" strokeWidth="1" strokeDasharray="2 4" />
        {[8, 20, 32, 44, 56, 68, 80, 92, 104, 116, 144, 156, 168, 180, 192].map((x, i) => (
          <rect key={x} x={x} y={i % 5 === 3 ? 39 : 34} width="1.6" height={i % 5 === 3 ? 6 : 11} fill={i % 5 === 3 ? '#8A6A1F' : '#0F7B5A'} />
        ))}
        <circle cx="196" cy="14" r="2.4" fill="#0F7B5A" />
      </svg>

      <h2 className="mt-6 font-display text-2xl">Nothing on the bench yet</h2>
      <p className="mx-auto mt-2 max-w-md text-base text-muted">
        Pick a product from the INE mock store and this becomes a strip chart: every price reading, every stock change,
        and a tick for every scrape attempt — including the ones that fail.
      </p>

      <button type="button" className="btn btn-primary mt-6" onClick={onOpenPalette}>
        Search the store
        <kbd className="ml-1 border border-paper/40 px-1 font-mono text-xs opacity-80">⌘K</kbd>
      </button>

      {status.data && (
        <p className="mt-4 font-mono text-xs text-muted">
          {status.data.indexed.toLocaleString('en-IN')} / {status.data.expected.toLocaleString('en-IN')} products indexed
        </p>
      )}
    </div>
  );
}

function Footnote({ rows }: { rows: TrackedRow[] }): JSX.Element {
  const readings = rows.reduce((n, r) => n + r.history_points, 0);
  const active = rows.filter((r) => r.is_active).length;
  return (
    <p className="mt-3 text-xs text-muted">
      {active} active of {rows.length} tracked · {readings.toLocaleString('en-IN')} stored readings · a gap in a trace
      means a scrape was attempted and its result was refused, not that nothing happened
    </p>
  );
}

function TableSkeleton(): JSX.Element {
  return (
    <div className="panel">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-6 border-b border-rule px-3 py-3.5 last:border-b-0">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="ml-auto h-3.5 w-20" />
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}
