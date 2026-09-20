import { useCallback, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { CommandPalette, usePaletteHotkey } from './components/CommandPalette';
import { Dashboard } from './pages/Dashboard';
import { ProductDetail } from './pages/ProductDetail';
import { Alerts } from './pages/Alerts';
import { api } from './lib/api';
import { timeAgo } from './lib/format';

export default function App(): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  usePaletteHotkey(openPalette);

  return (
    <div className="min-h-screen lg:flex">
      <Rail onOpenPalette={openPalette} />

      <main className="min-w-0 flex-1 px-4 pb-16 pt-6 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-content">
          <Routes>
            <Route path="/" element={<Dashboard onOpenPalette={openPalette} />} />
            <Route path="/p/:id" element={<ProductDetail />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onTracked={(id) => navigate(`/p/${id}`)} />

      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 4200,
          style: {
            background: '#FDFDFD',
            color: '#131A22',
            border: '1px solid #C6CBD1',
            borderRadius: '3px',
            boxShadow: '0 8px 24px -6px rgba(19,26,34,.22)',
            fontSize: '14px',
            fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
            padding: '10px 14px',
          },
          success: { iconTheme: { primary: '#0F7B5A', secondary: '#FDFDFD' } },
          error: { iconTheme: { primary: '#B4442C', secondary: '#FDFDFD' } },
        }}
      />
    </div>
  );
}

function Rail({ onOpenPalette }: { onOpenPalette: () => void }): JSX.Element {
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: api.alerts, refetchInterval: 60_000 });
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 120_000, retry: 1 });
  const unread = (alerts.data?.alerts ?? []).filter((a) => !a.read_at).length;

  return (
    <header className="shrink-0 border-b border-rule bg-panel lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-54 lg:flex-col lg:border-b-0 lg:border-r">
      <div className="flex items-center gap-2 px-3 py-2 sm:px-4 lg:flex-col lg:items-stretch lg:gap-0 lg:px-0 lg:py-0">
        <NavLink to="/" className="flex shrink-0 items-center gap-2 lg:border-b lg:border-rule lg:px-4 lg:py-4">
          <Mark />
          {/* The wordmark costs 120px the phone header does not have. */}
          <span className="hidden font-display text-lg leading-none sm:inline">Price Tracker</span>
        </NavLink>

        <nav className="flex min-w-0 flex-1 items-center gap-0.5 lg:flex-none lg:flex-col lg:items-stretch lg:gap-0 lg:py-2">
          <RailLink to="/" label="Dashboard" />
          <RailLink to="/alerts" label="Alerts" badge={unread} />
        </nav>

        <button
          type="button"
          onClick={onOpenPalette}
          className="btn btn-sm shrink-0 lg:mx-3 lg:mb-2 lg:justify-between"
          aria-label="Track a product"
        >
          <span className="hidden sm:inline">Track a product</span>
          <span className="sm:hidden" aria-hidden="true">
            <PlusGlyph />
          </span>
          <kbd className="hidden border border-rule px-1 font-mono text-xs text-muted lg:inline">⌘K</kbd>
        </button>
      </div>

      <div className="hidden px-4 pb-4 lg:mt-auto lg:block">
        <div className="border-t border-rule pt-3 text-xs text-muted">
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: health.isError ? '#B4442C' : health.data ? '#0F7B5A' : '#6B7580' }}
            />
            <span>
              {health.isError ? 'API unreachable' : health.data ? `API ${health.data.version}` : 'checking API…'}
            </span>
          </div>
          {health.data?.lastRunAt && <p className="mt-1 font-mono">last run {timeAgo(health.data.lastRunAt)}</p>}
        </div>
      </div>
    </header>
  );
}

function RailLink({ to, label, badge }: { to: string; label: string; badge?: number }): JSX.Element {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `flex items-center justify-between gap-2 px-3 py-1.5 text-base transition-colors duration-fast lg:px-4 lg:py-2 ${
          isActive ? 'bg-sunken font-medium text-ink lg:border-l-2 lg:border-l-ink lg:pl-[14px]' : 'text-muted hover:text-ink'
        }`
      }
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="min-w-[18px] bg-degraded px-1 text-center font-mono text-xs leading-[18px] text-white">
          {badge}
        </span>
      )}
    </NavLink>
  );
}

function PlusGlyph(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <line x1="7" y1="2.5" x2="7" y2="11.5" strokeLinecap="round" />
      <line x1="2.5" y1="7" x2="11.5" y2="7" strokeLinecap="round" />
    </svg>
  );
}

function Mark(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="4" fill="#131A22" />
      <path
        d="M5 21.5 L10.5 21.5 L14 12 L18 25 L21.5 17.5 L27 17.5"
        fill="none"
        stroke="#E9EBEE"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="14" cy="12" r="2" fill="#0F7B5A" />
    </svg>
  );
}

function NotFound(): JSX.Element {
  return (
    <div className="panel p-8">
      <h1 className="font-display text-2xl">Nothing here</h1>
      <p className="mt-2 text-base text-muted">That address does not match a page in this application.</p>
      <NavLink to="/" className="btn btn-sm mt-4">
        Back to the dashboard
      </NavLink>
    </div>
  );
}
