import { type App, Modal, Notice, Setting } from 'obsidian';
import { t } from '@/i18n';
import { ApiClient, ApiError } from '@/client/api';
import { uuid } from '@/utils/id';
import type { ServerConfig } from '../settings';

/**
 * Modal for adding a new sync server.
 *
 * Flow:
 *   1. User fills in name + URL + API key.
 *   2. "Test" runs `getMe()` against the server. On success the email
 *      shows up in a notice and the "Save" button unlocks.
 *   3. "Save" persists the server via the parent's `onAdd` callback.
 *
 * We require a successful test before allowing save — there's no good reason
 * to persist credentials we know are broken. If the user really wants to
 * add an offline server, they can re-test once the server is reachable.
 */
export class AddServerModal extends Modal {
  private name = '';
  private url = '';
  private apiKey = '';
  private tested = false;
  private saveButton: { setDisabled: (b: boolean) => void } | null = null;

  constructor(
    app: App,
    private readonly onAdd: (server: ServerConfig) => Promise<void> | void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: t('modal.addServer.title') });

    new Setting(contentEl).setName(t('modal.addServer.name.label')).addText((text) =>
      text.setPlaceholder(t('modal.addServer.name.placeholder')).onChange((value) => {
        this.name = value.trim();
        this.invalidate();
      }),
    );

    new Setting(contentEl).setName(t('modal.addServer.url.label')).addText((text) =>
      text.setPlaceholder(t('modal.addServer.url.placeholder')).onChange((value) => {
        this.url = value.trim();
        this.invalidate();
      }),
    );

    new Setting(contentEl).setName(t('modal.addServer.apiKey.label')).addText((text) =>
      text.setPlaceholder(t('modal.addServer.apiKey.placeholder')).onChange((value) => {
        this.apiKey = value.trim();
        this.invalidate();
      }),
    );

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t('modal.addServer.test')).onClick(async () => {
          if (!this.validateFields()) return;
          btn.setButtonText(t('modal.addServer.testing'));
          btn.setDisabled(true);
          try {
            const me = await new ApiClient({ url: this.url, apiKey: this.apiKey }).getMe();
            this.tested = true;
            this.saveButton?.setDisabled(false);
            new Notice(t('settings.servers.test.success', { email: me.email }));
          } catch (err) {
            this.tested = false;
            this.saveButton?.setDisabled(true);
            // Echo the underlying error to the DevTools console so the user
            // (and we, when debugging) can see the actual cause; the Notice
            // above only carries a localized one-liner.
            console.error('[obsidian-team] server test failed', err);
            new Notice(t('settings.servers.test.failure', { error: errorToText(err) }));
          } finally {
            btn.setButtonText(t('modal.addServer.test'));
            btn.setDisabled(false);
          }
        }),
      )
      .addButton((btn) => {
        this.saveButton = btn;
        btn
          .setButtonText(t('modal.addServer.save'))
          .setCta()
          .setDisabled(true)
          .onClick(async () => {
            if (!this.validateFields()) return;
            if (!this.tested) {
              new Notice(t('modal.addServer.errors.testFirst'));
              return;
            }
            const server: ServerConfig = {
              id: uuid(),
              name: this.name,
              url: this.url.replace(/\/+$/, ''),
              apiKey: this.apiKey,
              addedAt: Date.now(),
            };
            await this.onAdd(server);
            this.close();
          });
      })
      .addButton((btn) =>
        btn.setButtonText(t('modal.addServer.cancel')).onClick(() => this.close()),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  /** Any field change invalidates a previous successful test. */
  private invalidate(): void {
    this.tested = false;
    this.saveButton?.setDisabled(true);
  }

  private validateFields(): boolean {
    if (!this.name || !this.url || !this.apiKey) {
      new Notice(t('modal.addServer.errors.fields'));
      return false;
    }
    if (!/^https?:\/\//i.test(this.url)) {
      new Notice(t('modal.addServer.errors.url'));
      return false;
    }
    return true;
  }
}

function errorToText(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case 'unauthorized':
        return t('errors.unauthorized');
      case 'forbidden':
        return t('errors.forbidden');
      case 'network':
        return t('errors.network');
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : t('errors.unknown');
}
