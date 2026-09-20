/**
 * Small shared pieces.
 *
 * Every state indicator here carries a shape as well as a colour. A dashboard whose only
 * signal for "this scrape failed" is a red dot is unreadable to about 4% of the people
 * looking at it.
 */
import type { ReactNode } from 'react';
import type { Outcome, SparkPoint, StockStatus } from '../lib/api';
import { OUTCOME_COLOR, OUTCOME_LABEL, STOCK_COLOR, STOCK_LABEL } from '../lib/format';
import { breakThresholdMs, splitOnGaps } from '../lib/gaps';

/** Filled circle = success · half-filled = retried · ring with a slash = failed. */
export function OutcomeDot({ outcome, size = 10 }: { outcome: Outcome | null; size?: number }): JSX.Element {
  if (!outcome) {
    return (
      <svg width={size} height={size} viewBox="0 0 10 10" aria-label="No attempt yet" role="img">
        <circle cx="5" cy="5" r="3.4" fill="none" stroke="#C6CBD1" strokeWidth="1.2" strokeDasharray="1.6 1.6" />
      </svg>
    );
  }
  const color = OUTCOME_COLOR[outcome];
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" role="img" aria-label={OUTCOME_LABEL[outcome]}>
      {outcome === 'success' && <circle cx="5" cy="5" r="3.6" fill={color} />}
      {outcome === 'retried' && (
        <>
          <circle cx="5" cy="5" r="3.6" fill="none" stroke={color} strokeWidth="1.4" />
          <path d="M5 1.4 A3.6 3.6 0 0 1 5 8.6 Z" fill={color} />
        </>
      )}
      {outcome === 'failed' && (
        <>
          <circle cx="5" cy="5" r="3.6" fill="none" stroke={color} strokeWidth="1.4" />
          <line x1="2.2" y1="7.8" x2="7.8" y2="2.2" stroke={color} strokeWidth="1.4" />
        </>
      )}
      {outcome === 'skipped' && <circle cx="5" cy="5" r="3.6" fill="none" stroke={color} strokeWidth="1.4" strokeDasharray="2 1.6" />}
    </svg>
  );
}

export function StockPill({ status, quantity }: { status: StockStatus | null; quantity?: number | null }): JSX.Element {
  if (!status) return <span className="text-sm text-idle">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span
        aria-hidden="true"
        className="inline-block h-2 w-2"
        style={{
          background: status === 'unknown' ? 'transparent' : STOCK_COLOR[status],
          border: status === 'unknown' ? '1px dashed #6B7580' : undefined,
        }}
      />
      <span style={{ color: STOCK_COLOR[status] }}>{STOCK_LABEL[status]}</span>
      {quantity !== null && quantity !== undefined && status !== 'out_of_stock' && (
        <span className="font-mono text-xs text-muted">{quantity}</span>
      )}
    </span>
  );
}

export function DeltaBadge({ value }: { value: { label: string; direction: 'up' | 'down' | 'flat' } | null }): JSX.Element {
  if (!value) return <span className="font-mono text-sm text-idle">—</span>;
  const color = value.direction === 'down' ? '#0F7B5A' : value.direction === 'up' ? '#B4442C' : '#6B7580';
  return (
    <span className="font-mono text-sm" style={{ color }}>
      {value.label}
    </span>
  );
}

/** A sparkline with no axes. Broken where readings are far apart, same rule as the big chart. */
export function Sparkline({
  points,
  width = 108,
  height = 26,
  intervalMinutes = 120,
}: {
  points: SparkPoint[] | undefined;
  width?: number;
  height?: number;
  intervalMinutes?: number;
}): JSX.Element {
  if (!points || points.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="#C6CBD1" strokeWidth="1" strokeDasharray="2 3" />
      </svg>
    );
  }

  const times = points.map((p) => Date.parse(p.t));
  const prices = points.map((p) => p.price);
  const tMin = Math.min(...times);
  const tSpan = Math.max(1, Math.max(...times) - tMin);
  const pMin = Math.min(...prices);
  const pSpan = Math.max(1, Math.max(...prices) - pMin);

  const x = (t: number): number => ((t - tMin) / tSpan) * (width - 2) + 1;
  const y = (p: number): number => height - 3 - ((p - pMin) / pSpan) * (height - 6);

  // Same rule as the big chart: the spacing comes from the data, so changing a product's
  // interval does not retroactively shatter its trace.
  const threshold = breakThresholdMs(times, intervalMinutes);
  const segments = splitOnGaps(points, (p) => Date.parse(p.t), threshold)
    .map((seg) =>
      seg.length === 1
        ? `M ${(x(Date.parse((seg[0] as SparkPoint).t)) - 1).toFixed(1)} ${y((seg[0] as SparkPoint).price).toFixed(1)} L ${(x(Date.parse((seg[0] as SparkPoint).t)) + 1).toFixed(1)} ${y((seg[0] as SparkPoint).price).toFixed(1)}`
        : seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(Date.parse(p.t)).toFixed(1)} ${y(p.price).toFixed(1)}`).join(' '),
    );

  const last = points.at(-1) as SparkPoint;
  const first = points[0] as SparkPoint;
  const color = last.price < first.price ? '#0F7B5A' : last.price > first.price ? '#B4442C' : '#6B7580';

  return (
    <svg width={width} height={height} aria-hidden="true" className="overflow-visible">
      {segments.map((seg, i) => (
        <path key={i} d={seg} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
      ))}
      <circle cx={x(Date.parse(last.t))} cy={y(last.price)} r="1.9" fill={color} />
    </svg>
  );
}

export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

/** An error that says what happened and what to do, with the real code visible. */
export function ErrorPanel({
  title,
  message,
  code,
  onRetry,
}: {
  title: string;
  message: string;
  code?: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="panel border-l-2 border-l-rise p-4" role="alert">
      <p className="text-md font-semibold">{title}</p>
      <p className="mt-1 max-w-prose text-base text-muted">{message}</p>
      {code && <p className="mt-2 font-mono text-xs text-muted">code: {code}</p>}
      {onRetry && (
        <button type="button" className="btn btn-sm mt-3" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Panel({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2.5">
          {title && <h2 className="text-md font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** Small-caps key/value row used in the reading panel and metadata lists. */
export function Field({ k, children }: { k: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-1.5 last:border-b-0">
      <dt className="label">{k}</dt>
      <dd className="text-right text-base">{children}</dd>
    </div>
  );
}
