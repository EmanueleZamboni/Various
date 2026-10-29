import { describe, it, expect } from 'vitest';
import { domainOf } from './avatars.js';

describe('avatars', () => {
  it('extracts the domain', () => {
    expect(domainOf('Anna@NetStrategy.it')).toBe('netstrategy.it');
    expect(domainOf('nope')).toBe('');
  });
});
