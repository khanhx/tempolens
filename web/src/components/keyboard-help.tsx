import { useEffect, useRef } from 'preact/hooks';
import { helpOpen, SHORTCUTS } from './keyboard';

/** Modal list of keyboard shortcuts, opened with `?`. */
export function KeyboardHelp() {
  const ref = useRef<HTMLDialogElement>(null);
  const open = helpOpen.value;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} class="dialog" aria-labelledby="kbd-help-title" onClose={() => (helpOpen.value = false)}>
      <h2 id="kbd-help-title">Keyboard shortcuts</h2>
      <table class="kv">
        <tbody>
          {SHORTCUTS.map(([key, what]) => (
            <tr key={key}>
              <th scope="row">
                <kbd>{key}</kbd>
              </th>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form method="dialog">
        <button class="btn">Close</button>
      </form>
    </dialog>
  );
}
