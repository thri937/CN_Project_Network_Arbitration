/**
 * Icons.
 *
 * Hand-rolled inline SVGs rather than an icon package. The set is small and fixed, and a
 * dependency would add ~50 KB to ship a dozen glyphs. Every icon inherits `currentColor`
 * and sizes from its container, so they compose with the semantic colour classes.
 */
type IconProps = { className?: string };

const base = 'h-5 w-5 shrink-0';

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className ?? base}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const Icons = {
  dashboard: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </Svg>
  ),

  departments: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 21h18" />
      <path d="M5 21V7l7-4 7 4v14" />
      <path d="M9 21v-6h6v6" />
      <path d="M9 10h.01M15 10h.01" />
    </Svg>
  ),

  policy: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3l7 3v6c0 4.5-3 8.3-7 9-4-.7-7-4.5-7-9V6l7-3z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </Svg>
  ),

  slices: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="4.5" rx="1.5" />
      <rect x="3" y="12" width="18" height="4.5" rx="1.5" />
      <path d="M7 6.25h.01M7 14.25h.01" />
      <path d="M3 20h18" />
    </Svg>
  ),

  monitoring: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </Svg>
  ),

  contention: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3l9.5 16.5H2.5L12 3z" />
      <path d="M12 9.5v4.5" />
      <path d="M12 17h.01" />
    </Svg>
  ),

  arbitration: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v18" />
      <path d="M4 7h16" />
      <path d="M7 7l-3 6a3 3 0 006 0L7 7z" />
      <path d="M17 7l-3 6a3 3 0 006 0l-3-6z" />
    </Svg>
  ),

  audit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </Svg>
  ),

  reports: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 3v18h18" />
      <rect x="7" y="12" width="3" height="6" rx="0.75" />
      <rect x="12.5" y="8" width="3" height="10" rx="0.75" />
      <rect x="18" y="5" width="3" height="13" rx="0.75" />
    </Svg>
  ),

  analytics: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 019 9h-9V3z" />
      <path d="M12 12l5.5 5.5" />
    </Svg>
  ),

  settings: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.56V21a2 2 0 11-4 0v-.09A1.7 1.7 0 008.9 19.3a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.7 15a1.7 1.7 0 00-1.56-1H3a2 2 0 110-4h.09A1.7 1.7 0 004.7 8.9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.7a1.7 1.7 0 001-1.56V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.56 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.3 9c.14.35.4.65.73.85.3.18.65.27 1 .25H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.51 1z" />
    </Svg>
  ),

  users: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0113 0" />
      <path d="M16 5.2a3.5 3.5 0 010 6.6" />
      <path d="M18.5 20a6.5 6.5 0 00-3-5.5" />
    </Svg>
  ),

  bell: (p: IconProps) => (
    <Svg {...p}>
      <path d="M18 8a6 6 0 10-12 0c0 6-2.5 7-2.5 7h17S18 14 18 8z" />
      <path d="M10.3 20a2 2 0 003.4 0" />
    </Svg>
  ),

  sun: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  ),

  moon: (p: IconProps) => (
    <Svg {...p}>
      <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
    </Svg>
  ),

  logout: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </Svg>
  ),

  check: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),

  shield: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3l8 3.5v5c0 5-3.4 9.3-8 10.5-4.6-1.2-8-5.5-8-10.5v-5L12 3z" />
    </Svg>
  ),

  pause: (p: IconProps) => (
    <Svg {...p}>
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </Svg>
  ),

  play: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7 4.5l12 7.5-12 7.5V4.5z" />
    </Svg>
  ),

  refresh: (p: IconProps) => (
    <Svg {...p}>
      <path d="M21 12a9 9 0 11-2.6-6.4" />
      <path d="M21 4v5h-5" />
    </Svg>
  ),

  chevronRight: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  ),

  close: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  ),

  menu: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  ),

  network: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5" cy="5" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M6.5 6.5l3.8 3.8M17.5 6.5l-3.8 3.8M6.5 17.5l3.8-3.8M17.5 17.5l-3.8-3.8" />
    </Svg>
  ),
};
