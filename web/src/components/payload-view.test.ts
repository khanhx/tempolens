// @vitest-environment happy-dom
// A payload over 64 KB renders collapsed and is decoded only when expanded.
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { textToBase64 } from '../lib/payload/base64';
import * as decode from '../lib/payload/decode';
import { PayloadView } from './payload-view';

// Count the view's own decode calls; the codec's tree walk calls decodePayload
// inside its module, so only an explicit expand reaches this spy.
vi.mock('../lib/payload/decode', async (importOriginal) => {
  const real = await importOriginal<typeof decode>();
  return { ...real, decodePayload: vi.fn(real.decodePayload) };
});

const BIG_TEXT = 'x'.repeat(decode.LARGE_PAYLOAD_BYTES + 1024);
const bigPayload = { metadata: { encoding: textToBase64('json/plain') }, data: textToBase64(JSON.stringify(BIG_TEXT)) };

const decodeButton = (root: HTMLElement) => [...root.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Large payload'));

async function mount(value: unknown): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.append(root);
  await act(async () => {
    render(h(PayloadView, { value, ns: 'tui-test-ui-a' }), root);
  });
  // The decode runs in an effect and resolves a promise; let it settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.mocked(decode.decodePayload).mockClear();
});

describe('PayloadView with a large payload', () => {
  it('renders a payload over 64 KB collapsed without decoding it', async () => {
    const root = await mount({ payloads: [bigPayload] });
    expect(decodeButton(root)?.textContent).toMatch(/^Large payload \(\d+\.\d KB, json\/plain\): decode$/);
    expect(root.textContent).not.toContain(BIG_TEXT.slice(0, 100));
    expect(decode.decodePayload).not.toHaveBeenCalled();
  });

  it('decodes and shows the value only when expanded', async () => {
    const root = await mount({ payloads: [bigPayload] });
    await act(async () => {
      decodeButton(root)?.click();
    });
    expect(decode.decodePayload).toHaveBeenCalledTimes(1);
    expect(decode.decodePayload).toHaveBeenCalledWith(bigPayload, true);
    expect(root.textContent).toContain(BIG_TEXT);
    expect(root.textContent).not.toContain('Large payload');
  });

  it('decodes a small payload at once, without an expand step', async () => {
    const small = { metadata: { encoding: textToBase64('json/plain') }, data: textToBase64('"hello"') };
    const root = await mount({ payloads: [small] });
    expect(root.textContent).toContain('"hello"');
    expect(root.textContent).not.toContain('Large payload');
  });
});
