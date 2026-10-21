import { forwardRef, useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { HubError } from '../api/hub';
import { SpindleLoader } from '../brand/logo';
import { IconClose } from './icons';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }>(
  function Button({ variant = 'secondary', size = 'md', busy, className, children, disabled, ...rest }, ref) {
    return (
      <button ref={ref} className={`btn btn-${variant} btn-${size} ${className ?? ''}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
        {children}
      </button>
    );
  },
);

export function PageHeader({ title, description, actions, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Panel({ title, actions, children, className, flush, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean; id?: string }) {
  const headingId = useId();
  return (
    <section className={`panel ${flush ? 'panel-flush' : ''} ${className ?? ''}`} aria-labelledby={title ? headingId : undefined} id={id}>
      {(title || actions) && (
        <div className="panel-header">
          {title && <h2 id={headingId}>{title}</h2>}
          {actions && <div className="panel-actions">{actions}</div>}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state state-loading">
      <SpindleLoader size={20} label={label} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {children && <p className="state-text">{children}</p>}
      {action && <div className="state-action">{action}</div>}
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
          : `${error.message} (${error.code})`
      : error.message;
  return (
    <div className="state state-error" role="alert">
      <p className="state-title">Couldn’t load {what}.</p>
      <p className="state-text">{detail}</p>
      {onRetry && (
        <div className="state-action">
          <Button onClick={onRetry}>Try again</Button>
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
      className={`dialog ${wide ? 'dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-footer">{footer}</div>}
    </dialog>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor: string }) {
  return (
    <div className={`field ${error ? 'field-invalid' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <p className="field-error" id={`${htmlFor}-error`}>
          {error}
        </p>
      ) : (
        hint && <p className="field-hint">{hint}</p>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange(value: T): void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'is-selected' : ''}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === value);
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault();
              onChange(options[(i + 1) % options.length].value);
              (e.currentTarget.parentElement?.children[(i + 1) % options.length] as HTMLElement | undefined)?.focus();
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault();
              const j = (i - 1 + options.length) % options.length;
              onChange(options[j].value);
              (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus();
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Ruled meter with an explicit number beside it. */
export function Meter({ value, max, label, tone = 'ink' }: { value: number; max: number; label: string; tone?: 'ink' | 'accent' | 'error' | 'warning' }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span className={`meter-fill meter-${tone}`} style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}

export function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>
        <span className="stat-value">{value}</span>
        {detail && <span className="stat-detail">{detail}</span>}
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
