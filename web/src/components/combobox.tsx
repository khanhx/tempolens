import './combobox.css';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';

export interface ComboOption {
  value: string;
  /** Extra text shown after the value, such as a count. */
  hint?: ComponentChildren;
}

interface Props {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  onInput: (value: string) => void;
  /** Options to list, already filtered for the current value. */
  options: readonly ComboOption[];
  /** A chosen option, by click or by Enter on the highlighted one. */
  onPick: (value: string) => void;
  /** Marks the input as the page's search field for the `/` shortcut. */
  shortcutSearch?: boolean;
}

/**
 * A text input with a suggestion list (ARIA 1.2 combobox, list autocomplete).
 * The list opens on focus and typing; ↑/↓ move the highlight, Enter picks the
 * highlighted option, Escape closes the list. Enter with nothing highlighted is
 * left to the surrounding form, so free text still submits.
 */
export function Combobox({ id, label, placeholder, value, onInput, options, onPick, shortcutSearch }: Props) {
  const listId = `${id}-list`;
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const open = expanded && options.length > 0;
  const current = active < options.length ? active : -1;

  const close = () => {
    setExpanded(false);
    setActive(-1);
  };
  const pick = (option: ComboOption) => {
    close();
    onPick(option.value);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = options.length;
      if (!n) return;
      if (!open) {
        setExpanded(true);
        setActive(e.key === 'ArrowDown' ? 0 : n - 1);
        return;
      }
      setActive(e.key === 'ArrowDown' ? (current + 1) % n : (current <= 0 ? n : current) - 1);
      return;
    }
    if (e.key === 'Enter' && open && current >= 0) {
      e.preventDefault();
      pick(options[current] as ComboOption);
      return;
    }
    if (e.key === 'Escape' && open) {
      // Keep the shell's Escape (blur) from firing too.
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Enter') close();
  };

  return (
    <div class="combo">
      <input
        id={id}
        class="input"
        type="text"
        role="combobox"
        data-shortcut-search={shortcutSearch || undefined}
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && current >= 0 ? `${listId}-${current}` : undefined}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        placeholder={placeholder}
        value={value}
        onInput={(e) => {
          onInput(e.currentTarget.value);
          setExpanded(true);
          setActive(-1);
        }}
        onFocus={() => setExpanded(true)}
        onClick={() => setExpanded(true)}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <ul id={listId} class="combo-list" role="listbox" aria-label={`${label} suggestions`} hidden={!open}>
        {open &&
          options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              // mousedown, so the input keeps focus and the blur does not close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
              onMouseMove={() => setActive(i)}
            >
              <span class="combo-value">{o.value}</span>
              {o.hint && <span class="combo-hint">{o.hint}</span>}
            </li>
          ))}
      </ul>
    </div>
  );
}
