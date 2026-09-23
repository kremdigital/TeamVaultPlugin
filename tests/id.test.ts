import { uuid } from '@/utils/id';
import { stubWindow } from './window-stub';

describe('uuid', () => {
  it('returns a v4 UUID', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('takes it from window.crypto', () => {
    const win = stubWindow({ crypto: { randomUUID: () => 'from-window' } });
    try {
      expect(uuid()).toBe('from-window');
    } finally {
      win.restore();
    }
  });
});
