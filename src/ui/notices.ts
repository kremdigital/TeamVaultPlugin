import { Notice } from 'obsidian';
import { t } from '@/i18n';
import { describeSyncDetail } from './sync-detail';

/**
 * Tiny wrapper over Obsidian's `Notice` that respects the
 * `showSyncNotifications` setting. Some notices are too important to
 * silence (`error` is always shown); the rest only fire when the user
 * has opted in.
 */
export interface NoticeServiceOptions {
  /** Live setting reader — re-evaluated on every notice. */
  isEnabled: () => boolean;
  /** Default Notice timeout in ms. Obsidian default is ~5 s. */
  defaultTimeoutMs?: number;
  /** Test seam — defaults to `new Notice(...)`. */
  show?: (message: string, timeoutMs: number) => void;
}

export class NoticeService {
  private readonly options: Required<
    Pick<NoticeServiceOptions, 'isEnabled' | 'defaultTimeoutMs'>
  > & {
    show: (message: string, timeoutMs: number) => void;
  };

  constructor(options: NoticeServiceOptions) {
    this.options = {
      isEnabled: options.isEnabled,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 5000,
      show: options.show ?? ((m, t) => new Notice(m, t)),
    };
  }

  connected(serverName: string): void {
    this.maybeShow(t('notice.connected', { server: serverName }));
  }

  disconnected(serverName: string): void {
    this.maybeShow(t('notice.disconnected', { server: serverName }));
  }

  syncCompleted(): void {
    this.maybeShow(t('notice.syncCompleted'));
  }

  conflict(filePath: string): void {
    // Always shown — conflicts mean the user must take action.
    this.show(t('notice.conflict', { file: filePath }));
  }

  /** `error`: a status detail (see {@link describeSyncDetail}) or a message. */
  error(error: string): void {
    // Always shown.
    this.show(t('notice.error', { error: describeSyncDetail(error) }));
  }

  private maybeShow(message: string): void {
    if (this.options.isEnabled()) this.show(message);
  }

  private show(message: string, timeoutMs?: number): void {
    this.options.show(message, timeoutMs ?? this.options.defaultTimeoutMs);
  }
}
