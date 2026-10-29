import { useEffect, useRef, useState } from 'preact/hooks';
import { suggest } from '../../lib/console/complete';
import type { Suggestions } from '../../lib/console/complete';
import type { History } from '../../lib/console/history';
import { recall } from '../../lib/console/history';

const LIST_ID = 'console-suggestions';

/**
 * The CLI command line: a combobox whose list offers command words, flags,
 * namespaces and flag values. ↓ enters the list; ↑ recalls history unless a
 * suggestion is highlighted, and ↓ walks history back while the list is closed.
 * Enter submits the surrounding form unless it picks a suggestion.
 */
export function CommandInput({ value, onInput, history, namespaces }: { value: string; onInput: (v: string) => void; history: History; namespaces: readonly string[] }) {
  const ref = useRef<HTMLInputElement>(null);
  const [list, setList] = useState<Suggestions | null>(null);
  const [active, setActive] = useState(-1);
  const [recalled, setRecalled] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => ref.current?.focus(), []);

  const open = list !== null && list.items.length > 0;
  const close = () => {
    setList(null);
    setActive(-1);
  };
  const refresh = (text: string, cursor: number) => {
    // An empty line keeps ↑/↓ for history; suggestions start with the first character.
    const s = text.trim() ? suggest(text.slice(0, cursor), namespaces) : { from: 0, items: [] };
    setList(s.items.length ? s : null);
    setActive(-1);
  };

  const accept = (item: string) => {
    const el = ref.current;
    if (!el || !list) return;
    const cursor = el.selectionStart ?? value.length;
    const before = value.slice(0, list.from) + item + ' ';
    const next = before + value.slice(cursor).replace(/^\S*\s?/, '');
    onInput(next);
    requestAnimationFrame(() => {
      el.setSelectionRange(before.length, before.length);
      refresh(next, before.length);
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (open && list) {
      // ↑ with no suggestion chosen still means history, as in a shell.
      if (e.key === 'ArrowDown' || (e.key === 'ArrowUp' && active >= 0)) {
        e.preventDefault();
        const n = list.items.length;
        setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n : i) - 1));
        return;
      }
      if ((e.key === 'Enter' && active >= 0) || e.key === 'Tab') {
        e.preventDefault();
        accept(list.items[Math.max(active, 0)] as string);
        return;
      }
      if (e.key === 'Escape') {
        // Keep the shell's Escape (blur) from firing too.
        e.stopPropagation();
        close();
        return;
      }
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      close();
      const entries = history.entries();
      const next = recall(entries, recalled, e.key === 'ArrowUp' ? 'up' : 'down');
      if (next === recalled) return;
      e.preventDefault();
      if (recalled === null) setDraft(value);
      setRecalled(next);
      onInput(next === null ? draft : (entries[next] as string));
    }
    if (e.key === 'Enter') {
      setRecalled(null);
      close();
    }
  };

  return (
    <div class="console-combo">
      <input
        ref={ref}
        id="console-command"
        class="input input-mono"
        type="text"
        role="combobox"
        aria-label="Command"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={LIST_ID}
        aria-activedescendant={open && active >= 0 ? `${LIST_ID}-${active}` : undefined}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        placeholder={`workflow list --query 'ExecutionStatus = "Running"'`}
        value={value}
        onInput={(e) => {
          const el = e.currentTarget;
          onInput(el.value);
          setRecalled(null);
          refresh(el.value, el.selectionStart ?? el.value.length);
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <ul id={LIST_ID} class="console-suggest" role="listbox" aria-label="Suggestions" hidden={!open}>
        {open &&
          list.items.map((item, i) => (
            <li
              key={item}
              id={`${LIST_ID}-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown, so the input keeps focus and the blur does not close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                accept(item);
              }}
            >
              {item}
            </li>
          ))}
      </ul>
    </div>
  );
}
