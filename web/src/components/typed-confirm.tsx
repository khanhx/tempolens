/** Confirmation that only passes when the user types `expected` exactly. */
export function TypedConfirm({ expected, value, onInput, what }: { expected: string; value: string; onInput: (v: string) => void; what: string }) {
  return (
    <label class="field">
      <span>
        Type <code>{expected}</code> to confirm {what}.
      </span>
      <input class="input" value={value} autocomplete="off" spellcheck={false} onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)} />
    </label>
  );
}

export const confirmed = (expected: string, value: string) => expected !== '' && value.trim() === expected;
