/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // A replaced scale, not an extended one. Instruments do not need 22 greys.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      paper: '#E9EBEE',
      sunken: '#F4F5F7',
      panel: '#FDFDFD',
      hover: '#DDE1E6',
      ink: '#131A22',
      muted: '#8892A0',
      rule: '#C6CBD1',
      drop: '#0F7B5A',
      rise: '#B4442C',
      degraded: '#8A6A1F',
      idle: '#6B7580',
      focus: '#2A6FB5',
      white: '#FFFFFF',
    },
    fontFamily: {
      display: ['"Instrument Serif"', 'Georgia', 'serif'],
      sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
    },
    fontSize: {
      xs: ['12.5px', { lineHeight: '1.45' }],
      sm: ['13px', { lineHeight: '1.5' }],
      base: ['14px', { lineHeight: '1.55' }],
      md: ['15px', { lineHeight: '1.5' }],
      lg: ['17px', { lineHeight: '1.4' }],
      xl: ['20px', { lineHeight: '1.3' }],
      '2xl': ['28px', { lineHeight: '1.2' }],
      '4xl': ['56px', { lineHeight: '1.02' }],
    },
    extend: {
      borderRadius: { none: '0', sm: '2px', DEFAULT: '3px', md: '4px', lg: '6px' },
      boxShadow: {
        // Three, and each is for something that genuinely floats.
        palette: '0 24px 64px -12px rgba(19,26,34,.28), 0 0 0 1px rgba(19,26,34,.08)',
        toast: '0 8px 24px -6px rgba(19,26,34,.22), 0 0 0 1px rgba(19,26,34,.07)',
        readout: '0 6px 18px -6px rgba(19,26,34,.24), 0 0 0 1px rgba(19,26,34,.1)',
      },
      spacing: { 18: '4.5rem', 54: '13.5rem' },
      maxWidth: { content: '1180px' },
      transitionDuration: { fast: '120ms', DEFAULT: '160ms' },
    },
  },
  plugins: [],
};
