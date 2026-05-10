import { ItemView, type WorkspaceLeaf, TFile, type App } from 'obsidian';
import { t } from '@/i18n';
import { ApiClient, type ApiFileVersion } from '@/client/api';
import type { ServerConfig } from '@/settings/settings';

export const HISTORY_VIEW_TYPE = 'obsidian-team-history';

/**
 * Right-pane "History" view. Shows the version timeline for the file
 * the user has open in the editor.
 *
 * The view doesn't talk to the engine directly — the plugin top-level
 * resolves the active file's binding and hands us the (server, projectId,
 * fileId) triple via `resolveActive`. This keeps the view free of
 * engine-private state.
 */
export class HistoryView extends ItemView {
  private container: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly resolveActive: (
      app: App,
    ) => { server: ServerConfig; projectId: string; fileId: string } | null,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return HISTORY_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return t('history.title');
  }

  override getIcon(): string {
    return 'history';
  }

  override async onOpen(): Promise<void> {
    this.container = this.contentEl.createDiv({ cls: 'obsidian-team-history' });
    await this.refresh();
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => void this.refresh()));
  }

  override async onClose(): Promise<void> {
    this.container?.empty();
    this.container = null;
  }

  /** Re-pull versions for the currently open file and re-render. */
  async refresh(): Promise<void> {
    if (!this.container) return;
    this.container.empty();
    this.container.createEl('h3', { text: t('history.title') });

    const file = activeMarkdownFile(this.app);
    if (!file) {
      this.container.createEl('p', { text: t('history.empty') });
      return;
    }
    const ref = this.resolveActive(this.app);
    if (!ref) {
      this.container.createEl('p', { text: t('history.empty') });
      return;
    }

    const loading = this.container.createEl('p', { text: t('history.loading') });

    try {
      const api = new ApiClient(ref.server);
      const versions = await api.getFileVersions(ref.projectId, ref.fileId);
      loading.remove();
      this.renderList(this.container, versions);
    } catch (err) {
      loading.remove();
      this.container.createEl('p', {
        text: t('history.errorLoad', { error: err instanceof Error ? err.message : 'unknown' }),
      });
    }
  }

  private renderList(parent: HTMLElement, versions: ApiFileVersion[]): void {
    if (versions.length === 0) {
      parent.createEl('p', { text: t('history.noVersions') });
      return;
    }
    const list = parent.createEl('ul');
    list.style.listStyle = 'none';
    list.style.paddingLeft = '0';
    for (const v of versions) {
      const item = list.createEl('li');
      item.style.padding = '6px 0';
      item.style.borderBottom = '1px solid var(--background-modifier-border)';

      const head = item.createEl('div');
      head.style.display = 'flex';
      head.style.gap = '8px';
      head.createEl('strong', { text: `v${v.versionNumber}` });
      head.createEl('span', { text: new Date(v.createdAt).toLocaleString() });

      const author = item.createEl('div');
      author.style.fontSize = '11px';
      author.style.color = 'var(--text-muted)';
      author.setText(
        v.author ? t('history.byUser', { name: v.author.name ?? '—', email: v.author.email }) : '—',
      );

      if (v.message) {
        const msg = item.createEl('div', { text: v.message });
        msg.style.marginTop = '2px';
      }
    }
  }
}

function activeMarkdownFile(app: App): TFile | null {
  const file = app.workspace.getActiveFile();
  return file instanceof TFile ? file : null;
}
