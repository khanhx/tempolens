import type { ComponentChildren } from 'preact';
import type { WriteAction } from '../lib/me';
import { canAll, deniedReason } from '../lib/me';

export interface GatedButtonProps {
  actions: readonly WriteAction[];
  onClick: () => void;
  children: ComponentChildren;
  class?: string;
  /** Render nothing when denied (start, schedule create, Nexus create). */
  hideWhenDenied?: boolean;
  title?: string;
}

/**
 * A write button. When the user may not perform it, it is disabled with a
 * tooltip saying why, or hidden. The server enforces the same rules.
 */
export function GatedButton({ actions, onClick, children, class: cls = 'btn', hideWhenDenied, title }: GatedButtonProps) {
  const allowed = canAll(actions);
  if (!allowed && hideWhenDenied) return null;
  return (
    <button type="button" class={cls} disabled={!allowed} title={allowed ? title : (deniedReason(actions) ?? undefined)} onClick={onClick}>
      {children}
    </button>
  );
}

/** Renders children only when `actions` are allowed. */
export function RoleGate({ actions, children }: { actions: readonly WriteAction[]; children: ComponentChildren }) {
  return canAll(actions) ? <>{children}</> : null;
}
