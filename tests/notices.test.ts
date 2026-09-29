import { setLanguage } from '@/i18n';
import { NoticeService } from '@/ui/notices';

function build(opts: { enabled: boolean; show?: jest.Mock<void, [string, number]> }): {
  svc: NoticeService;
  show: jest.Mock<void, [string, number]>;
} {
  const show = opts.show ?? jest.fn<void, [string, number]>();
  const svc = new NoticeService({
    isEnabled: () => opts.enabled,
    show,
  });
  return { svc, show };
}

describe('NoticeService', () => {
  // The catalog is English until something picks one; the texts below are
  // asserted in Russian.
  beforeEach(() => setLanguage('ru'));

  it('shows informational notices when enabled', () => {
    const { svc, show } = build({ enabled: true });
    svc.connected('Local');
    svc.syncCompleted();
    expect(show).toHaveBeenCalledTimes(2);
    const messages = show.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => m.includes('Local'))).toBe(true);
    expect(messages.some((m) => m.includes('Синхронизация'))).toBe(true);
  });

  it('suppresses informational notices when disabled', () => {
    const { svc, show } = build({ enabled: false });
    svc.connected('Local');
    svc.disconnected('Local');
    svc.syncCompleted();
    expect(show).not.toHaveBeenCalled();
  });

  it('always shows error notices regardless of the setting', () => {
    const { svc, show } = build({ enabled: false });
    svc.error('boom');
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toContain('boom');
  });

  it('says join_failed in words, in either language, and that sync tries again', () => {
    const shown: Record<string, string> = {};
    for (const lang of ['ru', 'en'] as const) {
      setLanguage(lang);
      const { svc, show } = build({ enabled: false });
      svc.error('join_failed');
      shown[lang] = show.mock.calls[0]?.[0] ?? '';
    }
    expect(shown.ru).not.toContain('join_failed');
    expect(shown.ru).toContain('повторит попытку');
    expect(shown.en).not.toContain('join_failed');
    expect(shown.en).toContain('try again');
  });

  it('always shows conflict notices regardless of the setting', () => {
    const { svc, show } = build({ enabled: false });
    svc.conflict('note.md');
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[0]).toContain('note.md');
  });

  it('uses the configured default timeout', () => {
    const show = jest.fn<void, [string, number]>();
    const svc = new NoticeService({ isEnabled: () => true, show, defaultTimeoutMs: 1234 });
    svc.connected('Local');
    expect(show.mock.calls[0]?.[1]).toBe(1234);
  });
});
