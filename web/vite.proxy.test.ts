import { describe, expect, it } from 'vitest';
import { proxiedOrigin } from './vite.proxy';

describe('proxiedOrigin', () => {
  const target = 'http://localhost:8234';

  it('rewrites both dev-server origins to the target origin', () => {
    expect(proxiedOrigin('http://127.0.0.1:5173', target)).toBe('http://localhost:8234');
    expect(proxiedOrigin('http://localhost:5173', target)).toBe('http://localhost:8234');
  });

  it('strips any path from the target', () => {
    expect(proxiedOrigin('http://localhost:5173', 'https://ui.example.test:9443/base/')).toBe(
      'https://ui.example.test:9443',
    );
  });

  it('passes foreign origins through unchanged', () => {
    expect(proxiedOrigin('http://evil.test', target)).toBe('http://evil.test');
    expect(proxiedOrigin('http://localhost:5174', target)).toBe('http://localhost:5174');
    expect(proxiedOrigin('http://127.0.0.1:5173.evil.test', target)).toBe('http://127.0.0.1:5173.evil.test');
    expect(proxiedOrigin('null', target)).toBe('null');
  });

  it('leaves a missing Origin missing', () => {
    expect(proxiedOrigin(undefined, target)).toBeUndefined();
  });
});
