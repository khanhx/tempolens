import { useEffect, useState } from 'preact/hooks';
import { activeCodec, codecError, decodeWithCodec } from '../lib/payload/codec';
import { JsonView } from './json-view';

/**
 * Decodes `value` (a payload, `{payloads:[…]}`, or any tree containing
 * payloads) through the codec and base64/JSON, then shows it. A single
 * payload in a `payloads` array is shown unwrapped.
 */
export function PayloadView({ value, ns, openDepth = 3 }: { value: unknown; ns: string; openDepth?: number }) {
  const [state, setState] = useState<{ done: boolean; decoded?: unknown }>({ done: false });

  useEffect(() => {
    let cancelled = false;
    setState({ done: false });
    decodeWithCodec(value, ns).then(
      (decoded) => !cancelled && setState({ done: true, decoded }),
      // decodeWithCodec only rejects on programming errors; show the input as is.
      () => !cancelled && setState({ done: true, decoded: value }),
    );
    return () => {
      cancelled = true;
    };
  }, [value, ns]);

  const empty =
    value === undefined ||
    value === null ||
    (typeof value === 'object' && !Array.isArray(value) && (Object.keys(value).length === 0 || (Object.keys(value).length === 1 && Array.isArray((value as { payloads?: unknown }).payloads) && (value as { payloads: unknown[] }).payloads.length === 0)));
  if (empty) return <span class="muted">None</span>;
  if (!state.done) return <span class="muted">Decoding…</span>;
  let shown = state.decoded;
  const payloads = (shown as { payloads?: unknown } | null)?.payloads;
  if (shown && typeof shown === 'object' && Object.keys(shown).length === 1 && Array.isArray(payloads)) {
    shown = payloads.length === 1 ? payloads[0] : payloads;
  }
  return <JsonView value={shown} openDepth={openDepth} />;
}

/** Banner for the last codec failure, with the configured help text and link. */
export function CodecErrorBanner() {
  const error = codecError.value;
  const codec = activeCodec();
  if (!error || !codec) return null;
  return (
    <div class="alert alert-error" role="alert">
      {codec.defaultErrorMessage || 'Payloads could not be decoded by the codec server; they are shown undecoded.'}{' '}
      <span class="muted">({error})</span>{' '}
      {codec.defaultErrorLink && (
        <a href={codec.defaultErrorLink} target="_blank" rel="noopener noreferrer">
          Help
        </a>
      )}
    </div>
  );
}

