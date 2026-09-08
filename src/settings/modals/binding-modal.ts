import { type App, Modal, Notice, Setting } from 'obsidian';
import { t } from '@/i18n';
import { ApiClient, ApiError, type ApiProject } from '@/client/api';
import { uuid } from '@/utils/id';
import type { ServerConfig, VaultBinding } from '../settings';
import { FolderSuggestModal } from './folder-suggest-modal';
import { isFolderInUse, normalizeFolderPath } from '../folder-utils';

/**
 * Modal for binding a vault folder to a server-side project.
 *
 * Flow:
 *   1. Pick a server (dropdown).
 *   2. After server pick — fetch projects, render as a dropdown.
 *   3. Pick a project + a local folder (via FolderSuggestModal).
 *   4. Validate folder is not already bound, then save.
 */
export class AddBindingModal extends Modal {
  private serverId = '';
  private projects: ApiProject[] = [];
  private projectId = '';
  private projectsLoading = false;
  private projectsError: string | null = null;
  private localFolder = '';

  constructor(
    app: App,
    private readonly servers: ServerConfig[],
    private readonly existingBindings: VaultBinding[],
    private readonly onAdd: (binding: VaultBinding) => Promise<void> | void,
  ) {
    super(app);
  }

  override onOpen(): void {
    if (this.servers.length === 1) {
      const first = this.servers[0];
      if (first) {
        this.serverId = first.id;
        void this.loadProjects();
      }
    }
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t('modal.addBinding.title'));

    new Setting(contentEl).setName(t('modal.addBinding.server.label')).addDropdown((dd) => {
      dd.addOption('', t('modal.addBinding.server.placeholder'));
      for (const server of this.servers) {
        dd.addOption(server.id, server.name);
      }
      dd.setValue(this.serverId).onChange((value) => {
        this.serverId = value;
        this.projectId = '';
        this.projects = [];
        this.projectsError = null;
        if (value) void this.loadProjects();
        else this.render();
      });
    });

    const projectSetting = new Setting(contentEl).setName(t('modal.addBinding.project.label'));
    if (this.projectsLoading) {
      projectSetting.setDesc(t('modal.addBinding.project.loading'));
    } else if (this.projectsError) {
      projectSetting.setDesc(this.projectsError);
    } else if (this.serverId && this.projects.length === 0) {
      projectSetting.setDesc(t('modal.addBinding.project.empty'));
    } else {
      projectSetting.addDropdown((dd) => {
        dd.addOption('', t('modal.addBinding.server.placeholder'));
        for (const project of this.projects) {
          dd.addOption(project.id, project.name);
        }
        dd.setValue(this.projectId).onChange((value) => {
          this.projectId = value;
        });
        dd.setDisabled(!this.serverId || this.projects.length === 0);
      });
    }

    new Setting(contentEl)
      .setName(t('modal.addBinding.localFolder.label'))
      .setDesc(this.localFolder || t('modal.addBinding.localFolder.root'))
      .addButton((btn) =>
        btn.setButtonText(t('modal.addBinding.chooseFolder')).onClick(() => {
          new FolderSuggestModal(this.app, (path) => {
            this.localFolder = path;
            this.render();
          }).open();
        }),
      );

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(t('modal.addBinding.save'))
          .setCta()
          .onClick(async () => {
            if (!this.serverId) return new Notice(t('modal.addBinding.errors.serverRequired'));
            if (!this.projectId) return new Notice(t('modal.addBinding.errors.projectRequired'));
            if (!this.localFolder) return new Notice(t('modal.addBinding.errors.folderRequired'));
            const folder = normalizeFolderPath(this.localFolder);
            if (isFolderInUse(this.existingBindings, folder)) {
              return new Notice(t('modal.addBinding.errors.folderInUse'));
            }
            const project = this.projects.find((p) => p.id === this.projectId);
            const binding: VaultBinding = {
              id: uuid(),
              serverId: this.serverId,
              projectId: this.projectId,
              projectName: project?.name ?? this.projectId,
              localFolder: folder,
              enabled: true,
              lastSyncedAt: 0,
              lastVectorClock: {},
            };
            await this.onAdd(binding);
            this.close();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText(t('modal.addBinding.cancel')).onClick(() => this.close()),
      );
  }

  private async loadProjects(): Promise<void> {
    const server = this.servers.find((s) => s.id === this.serverId);
    if (!server) return;
    this.projectsLoading = true;
    this.projectsError = null;
    this.render();
    try {
      this.projects = await new ApiClient(server).getProjects();
    } catch (err) {
      this.projects = [];
      this.projectsError = errorToText(err);
    } finally {
      this.projectsLoading = false;
      this.render();
    }
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
