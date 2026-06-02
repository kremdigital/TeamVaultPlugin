import { type App, Menu, setIcon } from 'obsidian';
import { t } from '@/i18n';
import type { AggregateState, AggregateStatus, EngineManager } from '@/sync/engine-manager';

/**
 * Status-bar widget showing the aggregate engine state and an
 * action menu on click.
 *
 * Stage 10 ships a compact UI: an icon + a single-line label. The
 * popover with per-binding detail is rendered as an Obsidian
 * `Menu` for portability — full custom popovers can come later if
 * the menu feels limiting.
 */

export interface StatusBarCommands {
  syncNow: () => void;
  pause: () => void;
  resume: () => void;
  openSettings: () => void;
  openHistory: () => void;
}

export class StatusBar {
  private readonly el: HTMLElement;
  private readonly cleanups: Array<() => void> = [];
  private currentStatus: AggregateStatus = { state: 'idle', bindings: {} };

  constructor(
    private readonly app: App,
    container: HTMLElement,
    private readonly manager: EngineManager,
    private readonly commands: StatusBarCommands,
  ) {
    this.el = container;
    this.el.addClass('team-vault-status');
    this.el.style.display = 'inline-flex';
    this.el.style.alignItems = 'center';
    this.el.style.gap = '4px';
    this.el.style.cursor = 'pointer';

    this.el.addEventListener('click', this.onClick);

    const off = this.manager.onAggregateStatus((status) => {
      this.currentStatus = status;
      this.render();
    });
    this.cleanups.push(off);
    this.cleanups.push(() => this.el.removeEventListener('click', this.onClick));
  }

  destroy(): void {
    for (const cb of this.cleanups) cb();
    this.cleanups.length = 0;
    this.el.empty();
  }

  /** Re-render against the latest status. */
  render(): void {
    this.el.empty();
    const iconEl = this.el.createSpan();
    setIcon(iconEl, iconForState(this.currentStatus.state));
    const label = this.el.createSpan({ text: labelForState(this.currentStatus.state) });
    label.style.fontSize = '12px';
    if (this.currentStatus.detail) {
      this.el.setAttr('aria-label', this.currentStatus.detail);
      this.el.setAttr('title', this.currentStatus.detail);
    } else {
      this.el.removeAttribute('aria-label');
      this.el.removeAttribute('title');
    }
  }

  private readonly onClick = (event: MouseEvent): void => {
    const menu = new Menu();
    const paused = this.manager.isPaused();
    if (paused) {
      menu.addItem((it) =>
        it
          .setTitle(t('status.menu.resume'))
          .setIcon('play')
          .onClick(() => this.commands.resume()),
      );
    } else {
      menu.addItem((it) =>
        it
          .setTitle(t('status.menu.syncNow'))
          .setIcon('refresh-cw')
          .onClick(() => this.commands.syncNow()),
      );
      menu.addItem((it) =>
        it
          .setTitle(t('status.menu.pause'))
          .setIcon('pause')
          .onClick(() => this.commands.pause()),
      );
    }
    menu.addSeparator();
    menu.addItem((it) =>
      it
        .setTitle(t('status.menu.history'))
        .setIcon('history')
        .onClick(() => this.commands.openHistory()),
    );
    menu.addItem((it) =>
      it
        .setTitle(t('status.menu.settings'))
        .setIcon('settings')
        .onClick(() => this.commands.openSettings()),
    );
    // Suppress the unused variable warning — `app` is captured for parity
    // with future menu items that may need workspace state.
    void this.app;
    menu.showAtMouseEvent(event);
  };
}

function iconForState(state: AggregateState): string {
  switch (state) {
    case 'connected':
      return 'check-circle';
    case 'syncing':
    case 'connecting':
      return 'refresh-cw';
    case 'paused':
      return 'pause';
    case 'offline':
      return 'wifi-off';
    case 'error':
      return 'alert-circle';
    case 'idle':
    default:
      return 'circle';
  }
}

function labelForState(state: AggregateState): string {
  switch (state) {
    case 'connected':
      return t('status.connected');
    case 'syncing':
      return t('status.syncing');
    case 'connecting':
      return t('status.connecting');
    case 'paused':
      return t('status.paused');
    case 'offline':
      return t('status.offline');
    case 'error':
      return t('status.error');
    case 'idle':
    default:
      return t('status.idle');
  }
}
