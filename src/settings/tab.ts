import { type App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianSyncPlugin from '@/main';
import { t } from '@/i18n';
import { ApiClient, ApiError } from '@/client/api';
import {
  parseLanguageSetting,
  type LogLevel,
  type ServerConfig,
  type VaultBinding,
} from './settings';
import { AddServerModal } from './modals/server-modal';
import { AddBindingModal } from './modals/binding-modal';
import { LogViewerModal } from '@/ui/modals/log-viewer-modal';
import { confirmAction } from '@/ui/modals/confirm-modal';
import { canAddBinding, normalizeFolderPath } from './folder-utils';

/**
 * Top-level settings UI. Three sections, in order:
 *   1. Servers       — per-server entry with "test" and "remove" buttons.
 *   2. Bindings      — vault ↔ project link (one per vault; bindings made by
 *                      older versions may point to a subfolder).
 *   3. Behavior      — global options (language, debounce, notices, log).
 *
 * The tab itself owns no state; it always re-reads from `plugin.settings`
 * and re-renders on every `display()` call. Modals trigger a re-render
 * via the `onChanged` callback they receive.
 *
 * No `getSettingDefinitions()` (the declarative settings API, Obsidian 1.13)
 * — the directory's linter warns about it (prefer-setting-definitions). The
 * API is opt-in and needs 1.13, far above our minAppVersion; below it the
 * migration guide says to leave `display()` as it is. The cost: these
 * settings don't show up in 1.13's settings search.
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
    // No plugin-name heading here: Obsidian already titles the tab with it,
    // and the guidelines call a duplicate out. Sections below use
    // `setHeading()` rather than raw <h3>.

    this.renderServersSection(containerEl);
    this.renderBindingsSection(containerEl);
    this.renderBehaviorSection(containerEl);
  }

  // -- Servers ----------------------------------------------------------------

  private renderServersSection(parent: HTMLElement): void {
    new Setting(parent).setName(t('settings.servers.heading')).setHeading();

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
            const confirmed = await confirmAction(this.app, {
              title: t('settings.servers.removeTitle'),
              message: t('settings.servers.removeConfirm', { name: server.name }),
              confirmText: t('modal.confirm.remove'),
            });
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
    new Setting(parent).setName(t('settings.bindings.heading')).setHeading();

    const list = parent.createDiv({ cls: 'team-vault-binding-list' });
    if (this.plugin.settings.bindings.length === 0) {
      list.createEl('p', { text: t('settings.bindings.empty') });
    } else {
      for (const binding of this.plugin.settings.bindings) {
        this.renderBindingRow(list, binding);
      }
    }

    // A binding covers the whole vault, so it overlaps any other: one per vault.
    const alreadyBound = !canAddBinding(this.plugin.settings.bindings);
    const addSetting = new Setting(parent);
    if (alreadyBound) addSetting.setDesc(t('settings.bindings.onlyOne'));
    addSetting.addButton((btn) =>
      btn
        .setButtonText(t('settings.bindings.add'))
        .setCta()
        .setDisabled(this.plugin.settings.servers.length === 0 || alreadyBound)
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
    const serverName = server ? server.name : t('settings.bindings.serverMissing');
    // New bindings are always the vault root, which needs no caption; a folder
    // is shown only for a binding made earlier to a subfolder.
    const folder = normalizeFolderPath(binding.localFolder);
    const desc = folder === '/' ? serverName : `${serverName} · ${folder}`;

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
            const confirmed = await confirmAction(this.app, {
              title: t('settings.bindings.removeTitle'),
              message: t('settings.bindings.removeConfirm', { project: binding.projectName }),
              confirmText: t('modal.confirm.remove'),
            });
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
    new Setting(parent).setName(t('settings.behavior.heading')).setHeading();

    new Setting(parent)
      .setName(t('settings.behavior.language.name'))
      .setDesc(t('settings.behavior.language.desc'))
      .addDropdown((dd) =>
        dd
          .addOption('auto', t('settings.behavior.language.auto'))
          .addOption('ru', t('settings.behavior.language.ru'))
          .addOption('en', t('settings.behavior.language.en'))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = parseLanguageSetting(value);
            // saveSettings switches the catalog; redraw so this tab is in
            // the new language at once.
            await this.plugin.saveSettings();
            this.display();
          }),
      );

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
