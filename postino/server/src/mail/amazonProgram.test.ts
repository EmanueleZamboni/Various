import { describe, it, expect } from 'vitest';
import { isAmazonProgramNoise } from './sync.js';

describe('Amazon Associates program mail', () => {
  it('archives program news and promos, keeps offers to activate and every other sender', () => {
    expect(isAmazonProgramNoise('store-news@amazon.com', 'Upcoming changes to the program')).toBe(true);
    expect(isAmazonProgramNoise('promotion5@amazon.de', 'Jetzt ist die Zeit für deine Tipps')).toBe(true);
    expect(isAmazonProgramNoise('novedades@amazon.es', 'Próximas actualizaciones del reporting')).toBe(true);
    expect(isAmazonProgramNoise('amazon-offers@amazon.co.uk', 'Action needed: Re-opt in to your Creator Rewards offer')).toBe(false);
    expect(isAmazonProgramNoise('store-news@amazon.com', 'Hit your Creator Rewards target')).toBe(false);
    expect(isAmazonProgramNoise('shipment-tracking@amazon.it', 'Out for delivery')).toBe(false);
    expect(isAmazonProgramNoise('store-news@amazon.example.com', 'News')).toBe(true);
    expect(isAmazonProgramNoise('store-news@notamazon.com', 'News')).toBe(false);
  });
});
