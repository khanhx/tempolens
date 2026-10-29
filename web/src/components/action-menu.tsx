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
  /** Disables an item the role allows, such as deleting a protected namespace; shown as its tooltip. */
  disabledReason?: string | null;
}

/** Drop-down of write actions; denied ones stay visible but disabled, with the reason as tooltip. */
export function ActionMenu({
  label = 'Actions',
  ariaLabel,
  caret = true,
  items,
}: {
  label?: string;
  /** Accessible name when the visible label is only a symbol. */
  ariaLabel?: string;
  caret?: boolean;
  items: MenuAction[];
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const shown = items.filter((i) => !i.hidden);
  if (shown.length === 0) return null;
  return (
    <details class="menu" ref={ref}>
      <summary class="btn" aria-label={ariaLabel} title={ariaLabel}>
        {caret ? `${label} ▾` : label}
      </summary>
      <div class="menu-panel" role="menu">
        {shown.map((i) => {
          const allowed = canAll(i.actions);
          const why = (allowed ? null : deniedReason(i.actions)) ?? i.disabledReason ?? undefined;
          return (
            <button
              key={i.id}
              type="button"
              role="menuitem"
              class={i.danger ? 'menu-action menu-action-danger' : 'menu-action'}
              disabled={!allowed || !!i.disabledReason}
              title={why}
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
