/** Reason input. When required, the form cannot be submitted while it is blank (the server also checks). */
export function ReasonField({ value, onInput, required, label = 'Reason' }: { value: string; onInput: (v: string) => void; required?: boolean; label?: string }) {
  return (
    <label class="field">
      <span>
        {label} {required ? <span class="field-error">(required)</span> : <span class="muted">(optional)</span>}
      </span>
      <textarea
        class="input"
        rows={2}
        required={required}
        value={value}
        placeholder="Recorded in the workflow history and the audit log"
        onInput={(e) => onInput((e.currentTarget as HTMLTextAreaElement).value)}
      />
    </label>
  );
}

export const reasonOk = (value: string, required: boolean) => !required || value.trim().length > 0;
