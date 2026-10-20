import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { StatusStyle } from '@/lib/format';

/**
 * Design-system primitives.
 *
 * Small, unopinionated, composable. Every one accepts `className` and merges it through
 * `cn`, so a caller can override without fighting specificity.
 *
 * Kept in one file rather than one-per-component: they are each a handful of lines, they
 * change together, and a reviewer can see the whole vocabulary at once.
 */

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export function Card({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('card', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 py-4 border-b border-edge', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-content truncate">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-content-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-5', className)}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Status badge.
 *
 * Always renders a text label, never colour alone. Roughly 8 % of men have red/green colour
 * deficiency, and a NOC that encodes "degraded" purely as a hue is unusable for them —
 * during exactly the moments when reading it correctly matters most.
 */
export function Badge({
  style,
  children,
  dot,
  pulse,
  className,
}: {
  style: StatusStyle;
  children: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        style.text,
        style.bg,
        style.border,
        className,
      )}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          {pulse && (
            <span
              className={cn(
                'absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping',
                style.text.replace('text-', 'bg-'),
              )}
            />
          )}
          <span
            className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', style.text.replace('text-', 'bg-'))}
          />
        </span>
      )}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Metric                                                              */
/* ------------------------------------------------------------------ */

export function Metric({
  label,
  value,
  unit,
  hint,
  accent,
  size = 'md',
  className,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  accent?: string;
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="label">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className={cn(
            'tabular tracking-tight font-semibold',
            size === 'lg' ? 'text-metric-lg' : 'text-metric',
            accent ?? 'text-content',
          )}
        >
          {value}
        </span>
        {unit && <span className="text-sm font-medium text-content-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-xs text-content-muted">{hint}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bar                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Horizontal bar with an animated fill.
 *
 * `markerPercent` draws a reference line — used for the contractual floor on a slice's
 * bandwidth bar, so an operator can see at a glance how much headroom remains before the
 * guarantee is reached.
 */
export function Bar({
  percent,
  colourClass,
  markerPercent,
  markerLabel,
  overflowPercent,
  className,
}: {
  percent: number;
  colourClass: string;
  markerPercent?: number;
  markerLabel?: string;
  overflowPercent?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div className={cn('relative h-2 w-full rounded-full bg-surface-sunken overflow-hidden', className)}>
      <div
        className={cn('bandwidth-bar', colourClass)}
        style={{ width: `${clamped}%` }}
        role="presentation"
      />

      {/* Demand beyond the allocation — hatched, so over-subscription is visibly different
          from utilisation rather than just a longer bar. */}
      {overflowPercent !== undefined && overflowPercent > 0 && (
        <div
          className="absolute inset-y-0 bg-critical/40"
          style={{
            left: `${clamped}%`,
            width: `${Math.min(100 - clamped, overflowPercent)}%`,
            backgroundImage:
              'repeating-linear-gradient(45deg, transparent, transparent 3px, rgb(var(--critical) / 0.5) 3px, rgb(var(--critical) / 0.5) 6px)',
          }}
        />
      )}

      {markerPercent !== undefined && markerPercent > 0 && markerPercent < 100 && (
        <div
          className="absolute inset-y-0 w-px bg-content-subtle"
          style={{ left: `${markerPercent}%` }}
          title={markerLabel}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand/90 disabled:bg-brand/40',
  secondary:
    'bg-surface-raised border border-edge-strong text-content hover:bg-surface-sunken disabled:opacity-50',
  ghost: 'text-content-muted hover:text-content hover:bg-surface-sunken disabled:opacity-50',
  danger: 'bg-critical text-white hover:bg-critical/90 disabled:bg-critical/40',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  children,
  disabled,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        BUTTON_VARIANTS[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon && <div className="text-content-subtle">{icon}</div>}
      <div>
        <p className="text-sm font-medium text-content">{title}</p>
        {description && <p className="mt-1 text-xs text-content-muted max-w-sm">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-content-muted">
      <Spinner className="h-4 w-4" />
      {label}
    </div>
  );
}

/**
 * Error panel.
 *
 * Shows the correlation id when there is one. That id ties the browser failure to the exact
 * server-side log line, which turns "it broke" into a one-command investigation.
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  correlationId,
  onRetry,
}: {
  title?: string;
  message: string;
  correlationId?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="rounded-lg border border-critical/30 bg-critical/10 px-4 py-3 max-w-md">
        <p className="text-sm font-medium text-critical">{title}</p>
        <p className="mt-1 text-xs text-content-muted">{message}</p>
        {correlationId && (
          <p className="mt-2 font-mono text-[10px] text-content-subtle">
            Reference: {correlationId}
          </p>
        )}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Table                                                               */
/* ------------------------------------------------------------------ */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // Wide tables scroll inside their own container so the page body never scrolls sideways.
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = 'left',
  className,
}: {
  /** Optional: an actions column legitimately has an empty heading. */
  children?: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <th
      className={cn(
        'px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-content-subtle border-b border-edge whitespace-nowrap',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'left',
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <td
      className={cn(
        'px-4 py-2.5 border-b border-edge/60 text-content',
        align === 'right' && 'text-right tabular',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hover explanation.
 *
 * Used heavily on this dashboard: nearly every number is derived from a policy, and an
 * operator should be able to discover WHY without leaving the page. CSS-only, so it costs
 * nothing at 2 Hz refresh rates.
 */
export function Tooltip({
  content,
  children,
  position = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  position?: 'top' | 'bottom';
}) {
  return (
    <span className="group/tip relative inline-flex items-center">
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-[100] hidden whitespace-normal rounded-lg border border-edge-strong bg-slate-900/95 backdrop-blur-md px-3 py-2 text-xs font-normal leading-relaxed text-slate-100 shadow-2xl group-hover/tip:block w-64 max-w-[85vw]',
          position === 'top'
            ? 'bottom-full left-1/2 -translate-x-1/2 mb-2'
            : 'top-full left-1/2 -translate-x-1/2 mt-2',
        )}
      >
        {content}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-content">{title}</h1>
        {description && <p className="mt-1 text-sm text-content-muted max-w-2xl">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
