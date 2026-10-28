import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CopyButton } from './copy-button';

/** Native modal dialog; Escape and the backdrop close it through `onClose`. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} class={wide ? 'dialog dialog-wide' : 'dialog'} aria-label={title} onClose={onClose}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

export interface ActionDialogProps {
  title: string;
  submitLabel: string;
  danger?: boolean;
  /** Equivalent `temporal` command; a function so it reflects the current fields. */
  cli?: () => string;
  /** Throws to show an error and keep the dialog open. */
  onSubmit: () => Promise<void>;
  onClose: () => void;
  canSubmit?: boolean;
  children: ComponentChildren;
  wide?: boolean;
}

/** A modal form for one write: fields, error, "Copy as temporal CLI", cancel and submit. */
export function ActionDialog({ title, submitLabel, danger, cli, onSubmit, onClose, canSubmit = true, children, wide }: ActionDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      <form class="stack" onSubmit={submit}>
        {children}
        {error && (
          <p class="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <div class="dialog-footer">
          {cli && <CopyButton text={cli} label="Copy as temporal CLI" />}
          <span class="toolbar-spacer" />
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class={danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy || !canSubmit}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
