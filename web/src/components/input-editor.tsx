import type { InputEncoding } from '../lib/actions/encode';

export interface InputValue {
  text: string;
  encoding: InputEncoding;
  messageType: string;
}

export const EMPTY_INPUT: InputValue = { text: '', encoding: 'json/plain', messageType: '' };

/** One JSON value plus its payload encoding; a raw `{metadata,data}` payload is sent as is. */
export function InputEditor({ value, onChange, label = 'Input' }: { value: InputValue; onChange: (v: InputValue) => void; label?: string }) {
  return (
    <fieldset class="field">
      <legend>
        {label} <span class="muted">(one JSON value, optional)</span>
      </legend>
      <textarea
        class="input input-mono"
        rows={5}
        spellcheck={false}
        value={value.text}
        placeholder='{"orderId": 42}'
        onInput={(e) => onChange({ ...value, text: (e.currentTarget as HTMLTextAreaElement).value })}
      />
      <div class="toolbar-group">
        <select class="select" aria-label="Encoding" value={value.encoding} onChange={(e) => onChange({ ...value, encoding: (e.currentTarget as HTMLSelectElement).value as InputEncoding })}>
          <option value="json/plain">json/plain</option>
          <option value="json/protobuf">json/protobuf</option>
        </select>
        {value.encoding === 'json/protobuf' && (
          <input
            class="input"
            aria-label="Message type"
            placeholder="message type, e.g. my.pkg.Order"
            value={value.messageType}
            onInput={(e) => onChange({ ...value, messageType: (e.currentTarget as HTMLInputElement).value })}
          />
        )}
      </div>
    </fieldset>
  );
}
