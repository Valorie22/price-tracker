/**
 * Alerts: price drops, restocks, structure changes and repeated failures.
 *
 * Each one links back to the product it came from, and unread ones stay unread until you
 * look at them. Structure-change alerts carry the diff, because "the store moved something"
 * is only useful if it says what.
 */
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AlertRow } from '../lib/api';
import { ErrorPanel, Panel, Skeleton } from '../components/bits';
import { stamp, timeAgo } from '../lib/format';

const KIND_META: Record<AlertRow['kind'], { label: string; color: string; glyph: JSX.Element }> = {
  price_drop: { label: 'Price drop', color: '#0F7B5A', glyph: <Arrow down /> },
  back_in_stock: { label: 'Back in stock', color: '#0F7B5A', glyph: <Box /> },
  large_delta: { label: 'Large move', color: '#8A6A1F', glyph: <Spike /> },
  structure_change: { label: 'Store changed', color: '#8A6A1F', glyph: <Grid /> },
  repeated_failure: { label: 'Repeated failures', color: '#B4442C', glyph: <Cross /> },
  product_gone: { label: 'Product gone', color: '#B4442C', glyph: <Cross /> },
};

export function Alerts(): JSX.Element {
  const queryClient = useQueryClient();
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: api.alerts, refetchInterval: 60_000 });
  const tracked = useQuery({ queryKey: ['tracked'], queryFn: api.listTracked });

  const nameFor = (id: string | null): string | null =>
    id ? ((tracked.data?.tracked ?? []).find((t) => t.tracked_id === id)?.name ?? null) : null;

  const markRead = useMutation({
    mutationFn: (id: number) => api.readAlert(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['alerts'] }),
  });

  const rows = alerts.data?.alerts ?? [];
  const unread = rows.filter((a) => !a.read_at);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl leading-none">Alerts</h1>
          <p className="mt-1.5 text-base text-muted">
            Raised by the scraper as it runs. {unread.length > 0 ? `${unread.length} unread.` : 'All caught up.'}
          </p>
        </div>
        {unread.length > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => unread.forEach((a) => markRead.mutate(a.id))}
            disabled={markRead.isPending}
          >
            Mark all read
          </button>
        )}
      </header>

      {alerts.data && !alerts.data.emailConfigured && rows.length > 0 && (
        <p className="mb-4 panel border-l-2 border-l-rule px-4 py-2 text-sm text-muted">
          Email delivery is not configured. Alerts are recorded here regardless — set
          <code className="mx-1 font-mono text-xs">SENDGRID_API_KEY</code>,
          <code className="mx-1 font-mono text-xs">ALERT_TO_EMAIL</code> and
          <code className="mx-1 font-mono text-xs">ALERT_FROM_EMAIL</code> to also receive them by mail.
        </p>
      )}

      {alerts.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : alerts.isError ? (
        <ErrorPanel
          title="Could not load alerts"
          message={alerts.error instanceof Error ? alerts.error.message : 'The request failed.'}
          onRetry={() => void alerts.refetch()}
        />
      ) : rows.length === 0 ? (
        <Panel className="px-6 py-14 text-center">
          <h2 className="font-display text-xl">Nothing to report</h2>
          <p className="mx-auto mt-1.5 max-w-sm text-base text-muted">
            Price-drop thresholds and restock alerts are set on each product. Structure changes and repeated failures
            raise themselves.
          </p>
        </Panel>
      ) : (
        <ul className="space-y-2">
          {rows.map((alert) => {
            const meta = KIND_META[alert.kind];
            const name = nameFor(alert.tracked_product_id);
            return (
              <li key={alert.id}>
                <article
                  className={`panel flex items-start gap-3 border-l-2 px-4 py-3 ${alert.read_at ? 'opacity-60' : ''}`}
                  style={{ borderLeftColor: meta.color }}
                >
                  <span className="mt-0.5 shrink-0" style={{ color: meta.color }} aria-hidden="true">
                    {meta.glyph}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="font-medium" style={{ color: meta.color }}>
                        {meta.label}
                      </span>
                      <time className="font-mono text-xs text-muted" dateTime={alert.created_at} title={stamp(alert.created_at)}>
                        {timeAgo(alert.created_at)}
                      </time>
                      {alert.email_sent_at && <span className="text-xs text-muted">· emailed</span>}
                    </p>

                    <p className="mt-0.5 text-base">{alert.message}</p>

                    {alert.kind === 'structure_change' && alert.payload && <StructureDetail payload={alert.payload} />}

                    {alert.tracked_product_id && (
                      <Link
                        to={`/p/${alert.tracked_product_id}`}
                        className="mt-1.5 inline-flex min-h-[24px] items-center text-sm underline decoration-rule underline-offset-2 hover:decoration-ink"
                      >
                        {name ?? 'Open the product'}
                      </Link>
                    )}
                  </div>

                  {!alert.read_at && (
                    <button
                      type="button"
                      onClick={() => markRead.mutate(alert.id)}
                      className="inline-flex min-h-[24px] shrink-0 items-center px-1 text-xs text-muted hover:text-ink"
                    >
                      mark read
                    </button>
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function StructureDetail({ payload }: { payload: Record<string, unknown> }): JSX.Element {
  const previous = typeof payload['previous'] === 'string' ? payload['previous'] : null;
  const current = typeof payload['current'] === 'string' ? payload['current'] : null;
  return (
    <p className="mt-1 font-mono text-xs text-muted">
      {previous ? `${previous.slice(0, 22)} → ` : ''}
      {current?.slice(0, 22) ?? ''}
    </p>
  );
}

// --- glyphs: shapes, so colour is not the only signal ------------------------

function Arrow({ down }: { down?: boolean }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="7" y1={down ? 2 : 12} x2="7" y2={down ? 12 : 2} strokeLinecap="round" />
      <polyline points={down ? '3,8 7,12 11,8' : '3,6 7,2 11,6'} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Box(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="4" width="10" height="8" />
      <path d="M2 6.5h10M7 4v8" />
    </svg>
  );
}

function Spike(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="1,10 4,10 6,3 8,11 10,6 13,6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Grid(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="2" width="4" height="4" />
      <rect x="8" y="2" width="4" height="4" strokeDasharray="1.6 1.4" />
      <rect x="2" y="8" width="4" height="4" strokeDasharray="1.6 1.4" />
      <rect x="8" y="8" width="4" height="4" />
    </svg>
  );
}

function Cross(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="5.2" />
      <line x1="4.4" y1="9.6" x2="9.6" y2="4.4" strokeLinecap="round" />
    </svg>
  );
}
