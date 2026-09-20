/**
 * The strip chart.
 *
 * One graphic that answers "what has the price done?" and "did the scraper actually work?"
 * at the same time. The price line carries the readings; the baseline carries a tick for
 * every scrape attempt, including the ones that failed; a band underneath carries stock
 * state. Together they are the price history and the honest log in one picture.
 *
 * Two rules it does not bend:
 *
 *   A gap is drawn as a gap. Where a reading was rejected or a scrape failed, the line
 *   breaks. Joining across it would be a claim about a measurement nobody took — and the
 *   rejections are the whole point of the validation layer, so smoothing them away would
 *   erase the thing this project is graded on.
 *
 *   Colour is never the only carrier. Success, retried and failed ticks differ in shape
 *   as well as hue; the stock band hatches for `unknown`; deltas carry a sign.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AttemptMark, HistoryPoint, HistoryRange } from '../lib/api';
import { STOCK_COLOR, STOCK_LABEL, STRATEGY_LABEL, duration, money, stamp } from '../lib/format';
import { breakThresholdMs, splitOnGaps } from '../lib/gaps';

const PAD = { top: 18, right: 16, bottom: 46, left: 74 };
const BAND_H = 7;
const TICK_ROW_H = 16;

interface Props {
  points: HistoryPoint[];
  attempts: AttemptMark[];
  range: HistoryRange;
  onRangeChange: (r: HistoryRange) => void;
  intervalMinutes: number;
  height?: number;
  /** Highlights the newest reading when it has just arrived. */
  landingKey?: string | null;
}

const RANGES: { value: HistoryRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

interface Segment {
  points: (HistoryPoint & { x: number; y: number })[];
}

export function StripChart({
  points,
  attempts,
  range,
  onRangeChange,
  intervalMinutes,
  height = 300,
  landingKey = null,
}: Props): JSX.Element {
  const gradientId = useId();
  const hatchId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [width, setWidth] = useState(880);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Track the container width so the chart is genuinely responsive rather than relying on
  // viewBox scaling, which would shrink the axis type along with the plot.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth((prev) => (Math.abs(w - prev) > 4 ? Math.max(320, w) : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(120, width - PAD.left - PAD.right);
  const plotH = Math.max(90, height - PAD.top - PAD.bottom);

  const geometry = useMemo(() => {
    if (points.length === 0) return null;

    const times = points.map((p) => Date.parse(p.t));
    const attemptTimes = attempts.map((a) => Date.parse(a.t));
    const tMin = Math.min(...times, ...(attemptTimes.length ? attemptTimes : times));
    const tMax = Math.max(...times, ...(attemptTimes.length ? attemptTimes : times));
    const tSpan = Math.max(1, tMax - tMin);

    const prices = points.map((p) => p.price);
    let pMin = Math.min(...prices);
    let pMax = Math.max(...prices);
    if (pMax === pMin) {
      // A flat line should sit in the middle of the plot, not on its floor.
      pMin = pMin * 0.98;
      pMax = pMax * 1.02;
    }
    const headroom = (pMax - pMin) * 0.12;
    pMin -= headroom;
    pMax += headroom;

    const x = (t: number): number => PAD.left + ((t - tMin) / tSpan) * plotW;
    const y = (p: number): number => PAD.top + plotH - ((p - pMin) / (pMax - pMin)) * plotH;

    const placed = points.map((p) => ({ ...p, x: x(Date.parse(p.t)), y: y(p.price) }));

    // Break the line wherever a reading is meaningfully further from its neighbour than
    // this series normally is. A rejected or failed scrape leaves a visible hole instead
    // of a straight line pretending nothing happened. See lib/gaps.ts for why the spacing
    // comes from the data rather than from the configured interval.
    const threshold = breakThresholdMs(times, intervalMinutes);
    const segments: Segment[] = splitOnGaps(placed, (p) => Date.parse(p.t), threshold).map((points) => ({ points }));

    const gaps = segments.slice(0, -1).map((seg, i) => {
      const from = seg.points.at(-1) as (typeof placed)[number];
      const to = segments[i + 1]?.points[0] as (typeof placed)[number];
      return { from, to, ms: Date.parse(to.t) - Date.parse(from.t) };
    });

    // Four gridlines, on round-ish numbers.
    const ticks = Array.from({ length: 4 }, (_, i) => {
      const value = pMin + ((pMax - pMin) / 3) * i;
      return { value, y: y(value) };
    });

    return { placed, segments, gaps, ticks, x, y, tMin, tMax, pMin, pMax };
  }, [points, attempts, plotW, plotH, intervalMinutes]);

  const hovered = hoverIndex !== null ? geometry?.placed[hoverIndex] : undefined;

  function handleMove(event: React.MouseEvent<SVGSVGElement>): void {
    if (!geometry || geometry.placed.length === 0) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((event.clientX - rect.left) / rect.width) * width;
    let best = 0;
    let bestDistance = Infinity;
    for (const [i, p] of geometry.placed.entries()) {
      const d = Math.abs(p.x - px);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    setHoverIndex(best);
  }

  const baselineY = PAD.top + plotH + 14;
  const tickY = baselineY + BAND_H + 6;

  return (
    <figure ref={wrapRef} className="m-0">
      <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <span className="label">Price · stock · every attempt</span>
          <Legend />
        </div>
        <div role="group" aria-label="Chart range" className="flex border border-rule">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => onRangeChange(r.value)}
              aria-pressed={range === r.value}
              className={`min-h-[26px] px-3 py-1 text-sm font-medium transition-colors duration-fast ${
                range === r.value ? 'bg-ink text-paper' : 'bg-panel text-muted hover:bg-hover hover:text-ink'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </figcaption>

      <div className="relative panel">
        {!geometry ? (
          <EmptyPlot height={height} attempts={attempts} />
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            height={height}
            role="img"
            aria-label={`Price history: ${points.length} readings, ${attempts.length} scrape attempts, ${
              attempts.filter((a) => a.outcome !== 'success').length
            } of which did not succeed.`}
            onMouseMove={handleMove}
            onMouseLeave={() => setHoverIndex(null)}
            className="block select-none"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#131A22" stopOpacity="0.07" />
                <stop offset="100%" stopColor="#131A22" stopOpacity="0" />
              </linearGradient>
              <pattern id={hatchId} width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <rect width="5" height="5" fill="#E9EBEE" />
                <line x1="0" y1="0" x2="0" y2="5" stroke="#6B7580" strokeWidth="1.4" />
              </pattern>
            </defs>

            {/* grid + price axis */}
            {geometry.ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD.left} y1={t.y} x2={PAD.left + plotW} y2={t.y} stroke="#C6CBD1" strokeWidth="1" strokeDasharray={i === 0 ? undefined : '2 4'} />
                <text x={PAD.left - 10} y={t.y + 4} textAnchor="end" fontSize="11.5" fill="#8892A0" fontFamily="'IBM Plex Mono', monospace">
                  {money(Math.round(t.value), points[0]?.currency ?? 'INR')}
                </text>
              </g>
            ))}

            {/* area under the line, per unbroken segment */}
            {geometry.segments.map((seg, i) =>
              seg.points.length > 1 ? (
                <path
                  key={`area-${i}`}
                  d={`${linePath(seg.points)} L ${seg.points.at(-1)?.x} ${PAD.top + plotH} L ${seg.points[0]?.x} ${PAD.top + plotH} Z`}
                  fill={`url(#${gradientId})`}
                />
              ) : null,
            )}

            {/* the gaps, named rather than hidden */}
            {geometry.gaps.map((g, i) => (
              <g key={`gap-${i}`}>
                <line x1={g.from.x} y1={g.from.y} x2={g.to.x} y2={g.to.y} stroke="#8892A0" strokeWidth="1" strokeDasharray="2 5" opacity="0.55" />
                <rect x={g.from.x} y={PAD.top} width={Math.max(2, g.to.x - g.from.x)} height={plotH} fill="#8892A0" opacity="0.045" />
                {g.to.x - g.from.x > 46 && (
                  <text
                    x={(g.from.x + g.to.x) / 2}
                    y={PAD.top + 12}
                    textAnchor="middle"
                    fontSize="10.5"
                    fill="#8892A0"
                    fontFamily="'IBM Plex Sans', sans-serif"
                  >
                    no reading · {gapLabel(g.ms)}
                  </text>
                )}
              </g>
            ))}

            {/* the price line */}
            {geometry.segments.map((seg, i) => (
              <path
                key={`line-${i}`}
                d={linePath(seg.points)}
                fill="none"
                stroke="#131A22"
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}

            {/* reading markers */}
            {geometry.placed.map((p, i) => (
              <circle
                key={`pt-${i}`}
                cx={p.x}
                cy={p.y}
                r={hoverIndex === i ? 4 : 2.4}
                fill={hoverIndex === i ? '#131A22' : '#FDFDFD'}
                stroke="#131A22"
                strokeWidth="1.4"
                className={landingKey && i === geometry.placed.length - 1 ? 'mark-landing' : undefined}
              />
            ))}

            {/* stock band */}
            <g>
              {geometry.placed.map((p, i) => {
                const next = geometry.placed[i + 1];
                const w = next ? next.x - p.x : Math.max(4, plotW * 0.01);
                const fill = p.stockStatus === 'unknown' ? `url(#${hatchId})` : STOCK_COLOR[p.stockStatus];
                return <rect key={`band-${i}`} x={p.x} y={baselineY} width={Math.max(2, w)} height={BAND_H} fill={fill} opacity={p.stockStatus === 'unknown' ? 1 : 0.85} />;
              })}
              <text x={PAD.left - 10} y={baselineY + BAND_H} textAnchor="end" fontSize="10.5" fill="#8892A0" fontFamily="'IBM Plex Sans', sans-serif">
                stock
              </text>
            </g>

            {/* attempt ticks — the honest log, drawn */}
            <g>
              <line x1={PAD.left} y1={tickY + TICK_ROW_H} x2={PAD.left + plotW} y2={tickY + TICK_ROW_H} stroke="#C6CBD1" strokeWidth="1" />
              {attempts.map((a, i) => {
                const x = geometry.x(Date.parse(a.t));
                if (x < PAD.left - 2 || x > PAD.left + plotW + 2) return null;
                return <AttemptTick key={`att-${i}`} x={x} baseY={tickY + TICK_ROW_H} attempt={a} />;
              })}
              <text x={PAD.left - 10} y={tickY + TICK_ROW_H} textAnchor="end" fontSize="10.5" fill="#8892A0" fontFamily="'IBM Plex Sans', sans-serif">
                attempts
              </text>
            </g>

            {/* time axis */}
            <g>
              <text x={PAD.left} y={height - 6} fontSize="10.5" fill="#8892A0" fontFamily="'IBM Plex Mono', monospace">
                {stamp(new Date(geometry.tMin).toISOString())}
              </text>
              <text x={PAD.left + plotW} y={height - 6} textAnchor="end" fontSize="10.5" fill="#8892A0" fontFamily="'IBM Plex Mono', monospace">
                {stamp(new Date(geometry.tMax).toISOString())}
              </text>
            </g>

            {/* crosshair */}
            {hovered && (
              <line x1={hovered.x} y1={PAD.top} x2={hovered.x} y2={tickY + TICK_ROW_H} stroke="#131A22" strokeWidth="1" strokeDasharray="3 3" opacity="0.4" />
            )}
          </svg>
        )}

        {hovered && geometry && <Readout point={hovered} attempts={attempts} plotWidth={width} />}
      </div>
    </figure>
  );
}

// --- pieces ------------------------------------------------------------------

function linePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0] as { x: number; y: number };
    return `M ${p.x - 3} ${p.y} L ${p.x + 3} ${p.y}`;
  }
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
}

function gapLabel(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Three glyphs, three shapes:
 *   success  a filled bar to full height
 *   retried  a bar to half height (this attempt failed; another followed)
 *   failed   a hollow bar with a cross through it (nothing was stored)
 */
function AttemptTick({ x, baseY, attempt }: { x: number; baseY: number; attempt: AttemptMark }): JSX.Element {
  const title = `${stamp(attempt.t)} · attempt ${attempt.attempt} · ${attempt.outcome}${
    attempt.errorCode ? ` · ${attempt.errorCode}` : ''
  }${attempt.strategy ? ` · ${STRATEGY_LABEL[attempt.strategy]}` : ''} · ${duration(attempt.durationMs)}`;

  if (attempt.outcome === 'success') {
    return (
      <g>
        <title>{title}</title>
        <rect x={x - 1} y={baseY - 13} width="2" height="13" fill="#0F7B5A" />
      </g>
    );
  }
  if (attempt.outcome === 'retried') {
    return (
      <g>
        <title>{title}</title>
        <rect x={x - 1} y={baseY - 7} width="2" height="7" fill="#8A6A1F" />
      </g>
    );
  }
  return (
    <g>
      <title>{title}</title>
      <rect x={x - 1.6} y={baseY - 13} width="3.2" height="13" fill="none" stroke="#B4442C" strokeWidth="1" />
      <line x1={x - 3.2} y1={baseY - 13} x2={x + 3.2} y2={baseY} stroke="#B4442C" strokeWidth="1" />
    </g>
  );
}

function Legend(): JSX.Element {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <li className="flex items-center gap-1.5">
        <svg width="8" height="13" aria-hidden="true">
          <rect x="3" y="0" width="2" height="13" fill="#0F7B5A" />
        </svg>
        success
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="8" height="13" aria-hidden="true">
          <rect x="3" y="6" width="2" height="7" fill="#8A6A1F" />
        </svg>
        retried
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="10" height="13" aria-hidden="true">
          <rect x="3.2" y="0" width="3.2" height="13" fill="none" stroke="#B4442C" strokeWidth="1" />
          <line x1="1.6" y1="0" x2="8" y2="13" stroke="#B4442C" strokeWidth="1" />
        </svg>
        failed
      </li>
    </ul>
  );
}

function Readout({
  point,
  attempts,
  plotWidth,
}: {
  point: HistoryPoint & { x: number; y: number };
  attempts: AttemptMark[];
  plotWidth: number;
}): JSX.Element {
  // The attempt that produced this reading, matched on time.
  const t = Date.parse(point.t);
  const source = attempts
    .filter((a) => a.outcome === 'success')
    .reduce<AttemptMark | null>((best, a) => {
      const d = Math.abs(Date.parse(a.t) - t);
      if (!best || d < Math.abs(Date.parse(best.t) - t)) return a;
      return best;
    }, null);

  const leftPct = (point.x / plotWidth) * 100;
  const flip = leftPct > 62;

  return (
    <div
      className="pointer-events-none absolute top-4 z-10 w-56 border border-rule bg-panel px-3 py-2 shadow-readout"
      style={flip ? { right: `${100 - leftPct + 1.5}%` } : { left: `${leftPct + 1.5}%` }}
    >
      <p className="font-mono text-xs text-muted">{stamp(point.t)}</p>
      <p className="mt-0.5 font-display text-xl leading-none">{money(point.price, point.currency)}</p>
      <dl className="mt-2 space-y-0.5 text-xs">
        <Row k="Stock">
          <span style={{ color: STOCK_COLOR[point.stockStatus] }}>{STOCK_LABEL[point.stockStatus]}</span>
          {point.stockQuantity !== null && <span className="text-muted"> · {point.stockQuantity} units</span>}
        </Row>
        {source?.strategy && <Row k="Read via">{STRATEGY_LABEL[source.strategy]}</Row>}
        {source && <Row k="Took">{duration(source.durationMs)}</Row>}
        {source && source.attempt > 1 && <Row k="Attempt">{source.attempt} of 4</Row>}
        {point.mrp !== null && <Row k="List price">{money(point.mrp, point.currency)}</Row>}
      </dl>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right font-mono">{children}</dd>
    </div>
  );
}

/**
 * No readings yet — but there may well have been attempts, and saying so is the honest
 * version of an empty state. "No data" when four attempts failed is a lie of omission.
 */
function EmptyPlot({ height, attempts }: { height: number; attempts: AttemptMark[] }): JSX.Element {
  const failures = attempts.filter((a) => a.outcome !== 'success').length;
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 text-center" style={{ height }}>
      <p className="text-base font-medium">No readings stored yet</p>
      {attempts.length === 0 ? (
        <p className="max-w-sm text-sm text-muted">
          The first scrape runs as soon as tracking starts. Give it a moment, or use Scrape now.
        </p>
      ) : (
        <p className="max-w-md text-sm text-muted">
          {attempts.length} attempt{attempts.length === 1 ? '' : 's'} so far, {failures} of which did not produce a
          storable reading. Nothing was written, which is the correct outcome — the scrape log below says why.
        </p>
      )}
    </div>
  );
}
