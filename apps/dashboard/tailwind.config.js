/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      /**
       * Semantic colours, not literal ones.
       *
       * Components reference `surface`, `border`, `muted` rather than `slate-800`, so the
       * light and dark themes are defined once in `index.css` as CSS variables instead of
       * being duplicated as `dark:` variants on every element. That matters here: a NOC
       * display is often wall-mounted in a dark room and desk-viewed in a bright one, and
       * both need to be genuinely legible rather than one being an afterthought.
       */
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
          sunken: 'rgb(var(--surface-sunken) / <alpha-value>)',
        },
        content: {
          DEFAULT: 'rgb(var(--content) / <alpha-value>)',
          muted: 'rgb(var(--content-muted) / <alpha-value>)',
          subtle: 'rgb(var(--content-subtle) / <alpha-value>)',
        },
        edge: {
          DEFAULT: 'rgb(var(--edge) / <alpha-value>)',
          strong: 'rgb(var(--edge-strong) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          muted: 'rgb(var(--brand-muted) / <alpha-value>)',
        },

        /* Operational status. Deliberately distinguishable in both themes AND for the
           ~8 % of men with red/green colour deficiency: severity is always carried by an
           icon and a label as well, never by hue alone. */
        healthy: 'rgb(var(--healthy) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        degraded: 'rgb(var(--degraded) / <alpha-value>)',
        critical: 'rgb(var(--critical) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
      },

      fontFamily: {
        sans: ['Inter var', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Consolas', 'monospace'],
      },

      fontSize: {
        // A dedicated scale for metric readouts — tabular figures at a legible size.
        metric: ['1.75rem', { lineHeight: '2rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        'metric-lg': ['2.5rem', { lineHeight: '2.75rem', letterSpacing: '-0.03em', fontWeight: '650' }],
      },

      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 200ms ease-out',
        'slide-up': 'slideUp 250ms cubic-bezier(0.16, 1, 0.3, 1)',
        'bar-grow': 'barGrow 500ms cubic-bezier(0.16, 1, 0.3, 1)',
        'flash-degrade': 'flashDegrade 1.2s ease-out',
        'flash-recover': 'flashRecover 1.2s ease-out',
      },

      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        barGrow: { from: { transform: 'scaleX(0)' }, to: { transform: 'scaleX(1)' } },
        flashDegrade: {
          '0%': { backgroundColor: 'rgb(var(--critical) / 0.28)' },
          '100%': { backgroundColor: 'transparent' },
        },
        flashRecover: {
          '0%': { backgroundColor: 'rgb(var(--healthy) / 0.28)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
    },
  },
  plugins: [],
};
