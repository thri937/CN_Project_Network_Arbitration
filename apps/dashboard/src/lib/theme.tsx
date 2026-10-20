import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Theme.
 *
 * `system` is a first-class option, not a fallback: a NOC wall display should follow the
 * room, while a desk browser should follow the operator's OS preference. The choice is
 * persisted, and `index.html` applies it before first paint so there is no flash of the
 * wrong theme — which on a dark-room wall display is a bright strobe several times a day.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'testbed.theme';

interface ThemeState {
  preference: ThemePreference;
  /** What is actually applied right now, after resolving `system`. */
  resolved: 'light' | 'dark';
  setPreference: (preference: ThemePreference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

function readStored(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* private mode */
  }
  return 'light';
}

function resolve(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStored);
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolve(readStored()));

  const apply = useCallback((next: ThemePreference) => {
    const effective = resolve(next);
    document.documentElement.classList.toggle('dark', effective === 'dark');
    setResolved(effective);
  }, []);

  useEffect(() => {
    apply(preference);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      /* private mode */
    }
  }, [preference, apply]);

  /* Follow the OS while the preference is `system`. */
  useEffect(() => {
    if (preference !== 'system') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference, apply]);

  const value = useMemo<ThemeState>(
    () => ({
      preference,
      resolved,
      setPreference: setPreferenceState,
      // Toggle resolves `system` to its opposite rather than cycling through three states:
      // a single click should visibly change something.
      toggle: () => setPreferenceState(resolved === 'dark' ? 'light' : 'dark'),
    }),
    [preference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside a <ThemeProvider>');
  return context;
}
