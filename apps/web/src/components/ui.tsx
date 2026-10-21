import { forwardRef, useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { HubError } from '../api/hub';
import { SpindleLoader } from '../brand/logo';
import { IconChevronDown, IconChevronLeft, IconClose, IconInbox, IconMore, IconXCircle } from './icons';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

/** Pills. One primary per view; secondary for other actions; ghost for quiet ones. */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean; icon?: boolean }>(function Button(
  { variant = 'secondary', size = 'md', busy, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={`btn btn-${variant} btn-${size} ${icon ? 'btn-icon' : ''} ${className ?? ''}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {children}
    </button>
  );
});

/** Class names for links styled as buttons. */
export const btn = (variant: Variant = 'secondary', size: Size = 'md', extra = '') => `btn btn-${variant} btn-${size} ${extra}`;

export function PageHeader({
  title,
  description,
  actions,
  meta,
  back,
  status,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  /** A back link above the title, such as "Runs". */
  back?: { label: string; to: string; params?: Record<string, string> };
  /** An inline status chip beside the title, for live objects. */
  status?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {back && (
          // Route strings are checked where PageHeader is used; the link only needs the path.
          <Link to={back.to as any} params={back.params as any} className="page-crumb">
            <IconChevronLeft size={16} />
            {back.label}
          </Link>
        )}
        <div className="page-title-row">
          <h1 className="page-title">{title}</h1>
          {status}
        </div>
        {description && <p className="page-sub">{description}</p>}
        {meta && <div className="page-sub">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/** A white card: one idea, a 16 px title and one quiet item on the right. */
export function Panel({ title, actions, children, className, id, compact }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean; id?: string; compact?: boolean }) {
  const headingId = useId();
  return (
    <section className={`card ${compact ? 'card-compact' : ''} ${className ?? ''}`} aria-labelledby={title ? headingId : undefined} id={id}>
      {(title || actions) && (
        <div className="card-head">
          {title && (
            <h2 className="card-title" id={headingId}>
              {title}
            </h2>
          )}
          {actions && <div className="card-aside">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Progressive disclosure: name what is hidden and how much. */
export function Disclosure({ summary, children, className, defaultOpen }: { summary: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean }) {
  return (
    <details className={`disclosure ${className ?? ''}`} open={defaultOpen}>
      <summary>
        {summary}
        <IconChevronDown size={16} />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state state-loading">
      <SpindleLoader size={32} label={label} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

/** One sentence on what goes here and one primary action. */
export function Empty({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <span className="tile tile-lg" aria-hidden="true">
        {icon ?? <IconInbox />}
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** Explains the affected operation and the recovery path. */
export function ErrorState({ what, error, onRetry }: { what: string; error: Error; onRetry?: () => void }) {
  const detail =
    error instanceof HubError
      ? error.status === 0
        ? 'The hub could not be reached. Check that it is running and that the URL in Settings is right.'
        : error.status === 401 || error.status === 403
          ? 'The hub rejected the owner token. Update it in Settings.'
          : error.message
      : error.message;
  return (
    <div className="error-state" role="alert">
      <div className="error-head">
        <IconXCircle size={20} />
        <h3>Couldn’t load {what}</h3>
      </div>
      <p className="error-text">{detail}</p>
      {error instanceof HubError && error.code && error.status !== 0 && <pre className="log">{`${error.status} ${error.code}`}</pre>}
      {onRetry && (
        <div className="actions">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

/** Wraps a resource: loading, error and empty handling in one place. */
export function Async<T>({ resource, what, children }: { resource: { data: T | undefined; error: Error | undefined; loading: boolean; reload(): void }; what: string; children: (data: T) => ReactNode }) {
  if (resource.data !== undefined) return <>{children(resource.data)}</>;
  if (resource.error) return <ErrorState what={what} error={resource.error} onRetry={resource.reload} />;
  return <Loading label={`Loading ${what}`} />;
}

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose(): void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`sheet ${wide ? 'sheet-wide' : ''}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="sheet-head">
        <h2 id={titleId}>{title}</h2>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Close">
          <IconClose size={18} />
        </button>
      </div>
      <div className="sheet-body">{children}</div>
      {footer && <div className="sheet-foot">{footer}</div>}
    </dialog>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor: string }) {
  return (
    <div className={`field ${error ? 'field-invalid' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field-error" id={`${htmlFor}-error`}>
          <IconXCircle size={16} />
          {error}
        </p>
      ) : (
        hint && <p className="field-help">{hint}</p>
      )}
    </div>
  );
}

/** A pill track; the selected option is a white pill. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; count?: ReactNode }[];
  onChange(value: T): void;
  className?: string;
}) {
  return (
    <div className={`seg ${className ?? ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === value);
            const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const j = (i + step + options.length) % options.length;
            onChange(options[j].value);
            (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus();
          }}
        >
          {o.label}
          {o.count !== undefined && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** 4 px pill meter in ink; the number sits beside it. */
export function Meter({ value, max, label, tone = 'ink' }: { value: number; max: number; label: string; tone?: 'ink' | 'error' }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span className={tone === 'error' ? 'meter-error' : ''} style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}

/** A headline number: value in 32 semibold, label beneath. Three at most in a row. */
export function Stat({ label, value, detail, unit }: { label: string; value: ReactNode; detail?: ReactNode; unit?: string }) {
  return (
    <div className="metric">
      <dt>
        {label}
        {detail && <span className="metric-detail"> · {detail}</span>}
      </dt>
      <dd>
        {value}
        {unit && <small>{unit}</small>}
      </dd>
    </div>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

/** An icon tile: 36 px, rounded, on the subtle surface. */
export function Tile({ children, small }: { children: ReactNode; small?: boolean }) {
  return (
    <span className={`tile ${small ? 'tile-sm' : ''}`} aria-hidden="true">
      {children}
    </span>
  );
}

/** Overflow actions behind a circular "More" button. */
export function Menu({ label, items }: { label: string; items: { label: string; onSelect(): void; icon?: ReactNode }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn btn-ghost btn-icon" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconMore />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
