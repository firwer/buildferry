import { ArrowUpRight, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function Brand() {
  return (
    <span className="brand">
      <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <path d="M7 25h26l-5 7H13l-6-7Z" fill="currentColor" />
        <path
          d="M13 22V12h14v10M17 12V7h6v5M5 35c3-3 7 3 10 0s7 3 10 0 7 3 10 0"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path d="M17 17h2m3 0h2" stroke="currentColor" strokeWidth="2" />
      </svg>
      BuildFerry<span className="brand-dot">.</span>
    </span>
  );
}

export function Failure({ error }: Readonly<{ error: Error | null }>) {
  return error ? (
    <p className="error" role="alert">
      {error.message}
    </p>
  ) : null;
}

export function Busy({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="busy">
      <LoaderCircle size={15} className="spinner" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Empty({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="empty">
      <div className="empty-symbol" aria-hidden="true">
        +
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Dialog({
  title,
  onClose,
  children,
}: Readonly<{ title: string; onClose: () => void; children: ReactNode }>) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog" aria-label={title} onCancel={onClose}>
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function External({
  href,
  children,
}: Readonly<{ href: string; children: ReactNode }>) {
  return (
    <a href={href} className="text-link" target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  );
}
