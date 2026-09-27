import { type App, Modal, Notice, Setting } from 'obsidian';
import { t } from '@/i18n';
import { ApiClient, ApiError } from '@/client/api';
import { uuid } from '@/utils/id';
import type { ServerConfig, VaultBinding } from '../settings';

/** What editing takes: the server, and the bindings made on it. */
export interface EditServerOptions {
  server: ServerConfig;
  /** Checked against the server's projects after a successful test. */
  bindings: readonly VaultBinding[];
}

/**
 * Modal for adding a sync server, or for editing one (`edit`).
 *
 * Flow:
 *   1. User fills in name + URL + API key.
 *   2. "Test" runs `getMe()` against the server. On success the email
 *      shows up in a notice and the "Save" button unlocks.
 *   3. "Save" hands the server to the parent's `onSave` callback.
 *
 * We require a successful test before allowing save — there's no good reason
 * to persist credentials we know are broken. If the user really wants to
 * add an offline server, they can re-test once the server is reachable.
 *
 * Editing keeps the server's id, so its bindings stay on it: the way to move
 * them to the server's new address. Removing the server and adding it again
 * switched them off, and a new binding starts from scratch — its offline
 * queue and documents are the old binding's. The name and URL come filled
 * in; the API key field stays empty, and empty keeps the current key, which
 * the modal never shows. A test is required only when the URL or the key
 * changes — a new name reaches no server.
 */
export class ServerModal extends Modal {
  private name = '';
  private url = '';
  private apiKey = '';
  private tested = false;
  /** Bumped on every field change: a test answers only for what it tested. */
  private revision = 0;
  private saveButton: { setDisabled: (b: boolean) => void } | null = null;

  constructor(
    app: App,
    private readonly onSave: (server: ServerConfig) => Promise<void> | void,
    private readonly edit?: EditServerOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const editing = this.edit?.server;
    if (editing) {
      this.titleEl.setText(t('modal.editServer.title'));
      this.name = editing.name;
      this.url = editing.url;
    } else {
      this.titleEl.setText(t('modal.addServer.title'));
    }

    new Setting(contentEl).setName(t('modal.addServer.name.label')).addText((text) =>
      text
        .setPlaceholder(t('modal.addServer.name.placeholder'))
        .setValue(this.name)
        .onChange((value) => {
          this.name = value.trim();
          this.invalidate();
        }),
    );

    new Setting(contentEl).setName(t('modal.addServer.url.label')).addText((text) =>
      text
        .setPlaceholder(t('modal.addServer.url.placeholder'))
        .setValue(this.url)
        .onChange((value) => {
          this.url = value.trim();
          this.invalidate();
        }),
    );

    const keySetting = new Setting(contentEl).setName(t('modal.addServer.apiKey.label'));
    // Never the stored key: it stays out of the field, and out of sight.
    if (editing) keySetting.setDesc(t('modal.editServer.apiKey.desc'));
    keySetting.addText((text) =>
      text.setPlaceholder(t('modal.addServer.apiKey.placeholder')).onChange((value) => {
        this.apiKey = value.trim();
        this.invalidate();
      }),
    );

    // Another server has projects of its own: the bindings would not find theirs.
    if (editing) new Setting(contentEl).setDesc(t('modal.editServer.sameServer'));

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t('modal.addServer.test')).onClick(async () => {
          if (!this.validateFields()) return;
          const revision = this.revision;
          btn.setButtonText(t('modal.addServer.testing'));
          btn.setDisabled(true);
          try {
            const client = new ApiClient(this.connection());
            const me = await client.getMe();
            if (revision !== this.revision) return;
            this.tested = true;
            this.updateSaveButton();
            new Notice(t('settings.servers.test.success', { email: me.email }));
            await this.checkBoundProjects(client, revision);
          } catch (err) {
            if (revision !== this.revision) return;
            this.tested = false;
            this.updateSaveButton();
            // The cause travels in the notice itself — no console echo. The
            // guidelines ask plugins to keep the console clean, and anything
            // worth keeping belongs in sync.log through the logger.
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
          .setDisabled(this.needsTest())
          .onClick(async () => {
            if (!this.validateFields()) return;
            if (this.needsTest()) {
              new Notice(t('modal.addServer.errors.testFirst'));
              return;
            }
            await this.onSave(this.result());
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
    this.revision++;
    this.tested = false;
    this.updateSaveButton();
  }

  private updateSaveButton(): void {
    this.saveButton?.setDisabled(this.needsTest());
  }

  /** Save waits for a test: of a new server, or of a new address or key. */
  private needsTest(): boolean {
    if (this.tested) return false;
    const editing = this.edit?.server;
    if (!editing) return true;
    const { url, apiKey } = this.connection();
    return url !== normalizeServerUrl(editing.url) || apiKey !== editing.apiKey;
  }

  /** The address and key to test and to save: an empty key keeps the current one. */
  private connection(): { url: string; apiKey: string } {
    return {
      url: normalizeServerUrl(this.url),
      apiKey: this.apiKey || (this.edit?.server.apiKey ?? ''),
    };
  }

  private result(): ServerConfig {
    const { url, apiKey } = this.connection();
    const editing = this.edit?.server;
    if (editing) return { ...editing, name: this.name, url, apiKey };
    return { id: uuid(), name: this.name, url, apiKey, addedAt: Date.now() };
  }

  /**
   * After a test of an edited server: say which of its bound projects the
   * server does not list for this key. Most likely the URL is another
   * server's, and those bindings would stop syncing with `project_not_found`.
   * Only a warning — Save stays open. No answer is no warning: the test itself
   * went through.
   */
  private async checkBoundProjects(client: ApiClient, revision: number): Promise<void> {
    const bindings = this.edit?.bindings ?? [];
    if (bindings.length === 0) return;
    let listed: Set<string>;
    try {
      listed = new Set((await client.getProjects()).map((p) => p.id));
    } catch {
      return;
    }
    if (revision !== this.revision) return;
    const missing = bindings.filter((b) => !listed.has(b.projectId));
    if (missing.length === 0) return;
    const projects = missing.map((b) => b.projectName || b.projectId).join(', ');
    new Notice(t('modal.editServer.projectsMissing', { projects }), 15_000);
  }

  private validateFields(): boolean {
    if (!this.name || !this.url || (!this.apiKey && !this.edit)) {
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

/** A server URL as the plugin saves it: no surrounding spaces, no trailing slash. */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
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
