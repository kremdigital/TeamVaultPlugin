import { type App, Modal, Setting } from 'obsidian';
import { t } from '@/i18n';
import type {
  BinaryConflictContext,
  BinaryConflictResolution,
  ConflictResolver,
  DeleteConflictContext,
  DeleteConflictResolution,
} from '@/sync/conflict';

/**
 * UI implementation of {@link ConflictResolver}. Surfaces the resolver
 * decisions as Obsidian modals.
 *
 * Stage 9 ships the bare minimum — sizes + path + the three (or two)
 * action buttons. Image previews and richer diff views are deferred to
 * later UX polish.
 */
export class UiConflictResolver implements ConflictResolver {
  constructor(private readonly app: App) {}

  resolveBinaryConflict(context: BinaryConflictContext): Promise<BinaryConflictResolution> {
    return new Promise((resolve) => {
      new BinaryConflictModal(this.app, context, resolve).open();
    });
  }

  resolveDeleteConflict(context: DeleteConflictContext): Promise<DeleteConflictResolution> {
    return new Promise((resolve) => {
      new DeleteConflictModal(this.app, context, resolve).open();
    });
  }
}

class BinaryConflictModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly context: BinaryConflictContext,
    private readonly onResolve: (r: BinaryConflictResolution) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t('modal.conflict.title'));
    contentEl.createEl('p', {
      text: t('modal.conflict.description', { file: this.context.filePath }),
    });
    contentEl.createEl('p', {
      text: t('modal.conflict.localSize', { size: formatBytes(this.context.localSize) }),
    });
    contentEl.createEl('p', {
      text: t('modal.conflict.serverSize', { size: formatBytes(this.context.serverSize) }),
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(t('modal.conflict.keepServer'))
          .setCta()
          .onClick(() => this.pick('keep-server')),
      )
      .addButton((btn) =>
        btn.setButtonText(t('modal.conflict.keepLocal')).onClick(() => this.pick('keep-local')),
      )
      .addButton((btn) =>
        btn.setButtonText(t('modal.conflict.keepBoth')).onClick(() => this.pick('keep-both')),
      );
  }

  override onClose(): void {
    // If the user closed via the X button, default to keep-server. The
    // engine treats that as "leave the file alone and adopt the server's
    // copy" — least surprising default.
    if (!this.resolved) this.onResolve('keep-server');
    this.contentEl.empty();
  }

  private pick(resolution: BinaryConflictResolution): void {
    this.resolved = true;
    this.onResolve(resolution);
    this.close();
  }
}

class DeleteConflictModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly context: DeleteConflictContext,
    private readonly onResolve: (r: DeleteConflictResolution) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t('modal.deleteConflict.title'));
    contentEl.createEl('p', {
      text: t('modal.deleteConflict.description', { file: this.context.filePath }),
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(t('modal.deleteConflict.restoreServer'))
          .setCta()
          .onClick(() => this.pick('restore-server')),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t('modal.deleteConflict.deleteLocal'))
          .setWarning()
          .onClick(() => this.pick('delete-local')),
      );
  }

  override onClose(): void {
    // Default for an unresolved delete-vs-update is "restore" — losing
    // the user's local edits silently is the worst outcome we could
    // pick by accident.
    if (!this.resolved) this.onResolve('restore-server');
    this.contentEl.empty();
  }

  private pick(resolution: DeleteConflictResolution): void {
    this.resolved = true;
    this.onResolve(resolution);
    this.close();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
