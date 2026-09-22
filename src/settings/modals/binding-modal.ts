import { type App, Modal, Notice, Setting } from 'obsidian';
import { t } from '@/i18n';
import { ApiClient, ApiError, type ApiProject } from '@/client/api';
import { uuid } from '@/utils/id';
import type { ServerConfig, VaultBinding } from '../settings';
import { canAddBinding, VAULT_ROOT } from '../folder-utils';

/**
 * Modal for binding the vault to a server-side project.
 *
 * Flow:
 *   1. Pick a server (dropdown).
 *   2. After server pick — fetch projects, render as a dropdown.
 *   3. Pick a project, then save.
 *
 * There is no folder to pick: the binding is the whole vault (`VAULT_ROOT`).
 * Picking a folder used to be a required extra step — the modal refused to
 * save without it — while the folder the user means is the vault root.
 */
export class AddBindingModal extends Modal {
  private serverId = '';
  private projects: ApiProject[] = [];
  private projectId = '';
  private projectsLoading = false;
  private projectsError: string | null = null;

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

    // The folder picker used to be the only hint of what gets synced. Without
    // it, say so plainly: binding uploads everything in the vault to the
    // project, and its members will see it.
    new Setting(contentEl).setDesc(t('modal.addBinding.scope'));

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(t('modal.addBinding.save'))
          .setCta()
          .onClick(async () => {
            if (!this.serverId) return new Notice(t('modal.addBinding.errors.serverRequired'));
            if (!this.projectId) return new Notice(t('modal.addBinding.errors.projectRequired'));
            // The settings tab disables "Add" once a binding exists; this is
            // the backstop for a modal opened before that.
            if (!canAddBinding(this.existingBindings)) {
              return new Notice(t('modal.addBinding.errors.alreadyBound'));
            }
            const project = this.projects.find((p) => p.id === this.projectId);
            const binding: VaultBinding = {
              id: uuid(),
              serverId: this.serverId,
              projectId: this.projectId,
              projectName: project?.name ?? this.projectId,
              localFolder: VAULT_ROOT,
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
