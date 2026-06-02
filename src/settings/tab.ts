import { type App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianSyncPlugin from '@/main';
import { t } from '@/i18n';
import { ApiClient, ApiError } from '@/client/api';
import type { LogLevel, ServerConfig, VaultBinding } from './settings';
import { AddServerModal } from './modals/server-modal';
import { AddBindingModal } from './modals/binding-modal';
import { LogViewerModal } from '@/ui/modals/log-viewer-modal';

/**
 * Top-level settings UI. Three sections, in order:
 *   1. Servers       — per-server entry with "test" and "remove" buttons.
 *   2. Bindings      — vault folder ↔ project links.
 *   3. Behavior      — global toggles (debounce, startup sync, …).
 *
 * The tab itself owns no state; it always re-reads from `plugin.settings`
 * and re-renders on every `display()` call. Modals trigger a re-render
 * via the `onChanged` callback they receive.
 */
export class SyncSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsidianSyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: t('settings.title') });

    this.renderServersSection(containerEl);
    this.renderBindingsSection(containerEl);
    this.renderBehaviorSection(containerEl);
  }

  // -- Servers ----------------------------------------------------------------

  private renderServersSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: t('settings.servers.heading') });

    const list = parent.createDiv({ cls: 'team-vault-server-list' });
    if (this.plugin.settings.servers.length === 0) {
      list.createEl('p', { text: t('settings.servers.empty') });
    } else {
      for (const server of this.plugin.settings.servers) {
        this.renderServerRow(list, server);
      }
    }

    new Setting(parent).addButton((btn) =>
      btn
        .setButtonText(t('settings.servers.add'))
        .setCta()
        .onClick(() => {
          new AddServerModal(this.app, async (server) => {
            this.plugin.settings.servers.push(server);
            await this.plugin.saveSettings();
            this.display();
          }).open();
        }),
    );
  }

  private renderServerRow(parent: HTMLElement, server: ServerConfig): void {
    new Setting(parent)
      .setName(server.name)
      .setDesc(server.url)
      .addButton((btn) =>
        btn.setButtonText(t('settings.servers.test')).onClick(async () => {
          btn.setDisabled(true);
          try {
            const me = await new ApiClient(server).getMe();
            new Notice(t('settings.servers.test.success', { email: me.email }));
          } catch (err) {
            new Notice(t('settings.servers.test.failure', { error: errorToText(err) }));
          } finally {
            btn.setDisabled(false);
          }
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t('settings.servers.remove'))
          .setWarning()
          .onClick(async () => {
            const confirmed = window.confirm(
              t('settings.servers.removeConfirm', { name: server.name }),
            );
            if (!confirmed) return;
            this.plugin.settings.servers = this.plugin.settings.servers.filter(
              (s) => s.id !== server.id,
            );
            // Disable bindings tied to this server but keep them — the user
            // may want to re-bind to a different server later.
            this.plugin.settings.bindings = this.plugin.settings.bindings.map((b) =>
              b.serverId === server.id ? { ...b, enabled: false } : b,
            );
            await this.plugin.saveSettings();
            this.display();
          }),
      );
  }

  // -- Bindings ---------------------------------------------------------------

  private renderBindingsSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: t('settings.bindings.heading') });

    const list = parent.createDiv({ cls: 'team-vault-binding-list' });
    if (this.plugin.settings.bindings.length === 0) {
      list.createEl('p', { text: t('settings.bindings.empty') });
    } else {
      for (const binding of this.plugin.settings.bindings) {
        this.renderBindingRow(list, binding);
      }
    }

    new Setting(parent).addButton((btn) =>
      btn
        .setButtonText(t('settings.bindings.add'))
        .setCta()
        .setDisabled(this.plugin.settings.servers.length === 0)
        .onClick(() => {
          new AddBindingModal(
            this.app,
            this.plugin.settings.servers,
            this.plugin.settings.bindings,
            async (binding) => {
              this.plugin.settings.bindings.push(binding);
              await this.plugin.saveSettings();
              this.display();
            },
          ).open();
        }),
    );
  }

  private renderBindingRow(parent: HTMLElement, binding: VaultBinding): void {
    const server = this.plugin.settings.servers.find((s) => s.id === binding.serverId);
    const desc = server
      ? `${server.name} · ${binding.localFolder || '/'}`
      : `${t('settings.bindings.serverMissing')} · ${binding.localFolder || '/'}`;

    new Setting(parent)
      .setName(binding.projectName || binding.projectId)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle.setValue(binding.enabled).onChange(async (value) => {
          binding.enabled = value;
          await this.plugin.saveSettings();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t('settings.bindings.remove'))
          .setWarning()
          .onClick(async () => {
            const confirmed = window.confirm(
              t('settings.bindings.removeConfirm', { project: binding.projectName }),
            );
            if (!confirmed) return;
            this.plugin.settings.bindings = this.plugin.settings.bindings.filter(
              (b) => b.id !== binding.id,
            );
            await this.plugin.saveSettings();
            this.display();
          }),
      );
  }

  // -- Behavior ---------------------------------------------------------------

  private renderBehaviorSection(parent: HTMLElement): void {
    parent.createEl('h3', { text: t('settings.behavior.heading') });

    new Setting(parent)
      .setName(t('settings.behavior.debounce.name'))
      .setDesc(t('settings.behavior.debounce.desc'))
      .addText((text) =>
        text.setValue(String(this.plugin.settings.debounceMs)).onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) {
            this.plugin.settings.debounceMs = Math.floor(n);
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(parent)
      .setName(t('settings.behavior.syncOnStartup.name'))
      .setDesc(t('settings.behavior.syncOnStartup.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(parent)
      .setName(t('settings.behavior.showNotifications.name'))
      .setDesc(t('settings.behavior.showNotifications.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showSyncNotifications).onChange(async (value) => {
          this.plugin.settings.showSyncNotifications = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(parent)
      .setName(t('settings.behavior.logLevel.name'))
      .setDesc(t('settings.behavior.logLevel.desc'))
      .addDropdown((dd) =>
        dd
          .addOption('error', t('settings.behavior.logLevel.error'))
          .addOption('warn', t('settings.behavior.logLevel.warn'))
          .addOption('info', t('settings.behavior.logLevel.info'))
          .addOption('debug', t('settings.behavior.logLevel.debug'))
          .setValue(this.plugin.settings.logLevel)
          .onChange(async (value) => {
            this.plugin.settings.logLevel = value as LogLevel;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(parent)
      .setName(t('settings.behavior.log.openName'))
      .setDesc(t('settings.behavior.log.openDesc'))
      .addButton((btn) =>
        btn.setButtonText(t('settings.behavior.log.open')).onClick(async () => {
          // Render the log in an in-app modal rather than a vault note.
          // A note would get picked up by the sync engine and propagated
          // to every other vault + the server — debug dumps are strictly
          // local diagnostic content, never shared state.
          const log = await this.plugin.readLogFile();
          new LogViewerModal(this.app, log, () => this.plugin.clearLogFile()).open();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t('settings.behavior.log.clear'))
          .setWarning()
          .onClick(async () => {
            await this.plugin.clearLogFile();
            new Notice(t('settings.behavior.log.clearedNotice'));
          }),
      );
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
