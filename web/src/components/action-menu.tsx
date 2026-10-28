import { useRef } from 'preact/hooks';
import type { WriteAction } from '../lib/me';
import { canAll, deniedReason } from '../lib/me';

export interface MenuAction {
  id: string;
  label: string;
  actions: readonly WriteAction[];
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/** Drop-down of write actions; denied ones stay visible but disabled, with the reason as tooltip. */
export function ActionMenu({ label = 'Actions', items }: { label?: string; items: MenuAction[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const shown = items.filter((i) => !i.hidden);
  if (shown.length === 0) return null;
  return (
    <details class="menu" ref={ref}>
      <summary class="btn">{label} ▾</summary>
      <div class="menu-panel" role="menu">
        {shown.map((i) => {
          const allowed = canAll(i.actions);
          return (
            <button
              key={i.id}
              type="button"
              role="menuitem"
              class={i.danger ? 'menu-action menu-action-danger' : 'menu-action'}
              disabled={!allowed}
              title={deniedReason(i.actions) ?? undefined}
              onClick={() => {
                if (ref.current) ref.current.open = false;
                i.onSelect();
              }}
            >
              {i.label}
            </button>
          );
        })}
      </div>
    </details>
  );
}
