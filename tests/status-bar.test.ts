/**
 * The status bar's tooltip carries the detail of the last status: a code the
 * user would be left to decode (`join_failed`) in words, in the language of
 * the plugin; any other detail as it is.
 */
import type { App } from 'obsidian';
import { setLanguage } from '@/i18n';
import type { AggregateListener, AggregateStatus, EngineManager } from '@/sync/engine-manager';
import { StatusBar } from '@/ui/status-bar';

/** The status-bar element: only what the widget calls, with its attributes kept. */
function element(): { el: HTMLElement; attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  const el = {
    addClass: (): void => undefined,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    empty: (): void => undefined,
    createSpan: (): unknown => ({}),
    setAttr: (name: string, value: string): void => void attrs.set(name, value),
    removeAttribute: (name: string): void => void attrs.delete(name),
  };
  return { el: el as unknown as HTMLElement, attrs };
}

/** A status bar over a manager that reports `status`. */
function barWith(status: AggregateStatus): Map<string, string> {
  const { el, attrs } = element();
  let listener: AggregateListener | null = null;
  const manager = {
    onAggregateStatus: (cb: AggregateListener): (() => void) => {
      listener = cb;
      return () => undefined;
    },
    isPaused: () => false,
  } as unknown as EngineManager;
  new StatusBar({} as App, el, manager, {
    syncNow: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    openSettings: () => undefined,
    openHistory: () => undefined,
  });
  (listener as AggregateListener | null)?.(status);
  return attrs;
}

describe('StatusBar — the detail in the tooltip', () => {
  afterEach(() => setLanguage('en'));

  it('says join_failed in words, in either language', () => {
    for (const [lang, words] of [
      ['ru', 'повторит попытку'],
      ['en', 'try again'],
    ] as const) {
      setLanguage(lang);
      const attrs = barWith({ state: 'error', detail: 'join_failed', bindings: {} });
      expect(attrs.get('title')).toContain(words);
      expect(attrs.get('title')).not.toContain('join_failed');
      expect(attrs.get('aria-label')).toBe(attrs.get('title'));
    }
  });

  it('shows any other detail as it is', () => {
    const attrs = barWith({ state: 'error', detail: 'server_outdated', bindings: {} });
    expect(attrs.get('title')).toBe('server_outdated');
  });
});
