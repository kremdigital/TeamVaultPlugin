import { type App, Modal, Notice, Setting } from 'obsidian';
import { t } from '@/i18n';

/**
 * In-app viewer for `sync.log`.
 *
 * Earlier the "Open log" button dumped the log into a fresh
 * `team-vault-log-<ts>.md` note. That worked, but the note lived
 * inside the vault — so the sync engine immediately picked it up and
 * propagated the debug dump to every other vault and the server. Showing
 * the content in a modal keeps the log strictly local to the device.
 */
export class LogViewerModal extends Modal {
  constructor(
    app: App,
    private readonly content: string,
    private readonly onClear: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t('modal.log.title'));

    const body = contentEl.createEl('pre', { cls: 'team-vault-log-body' });
    body.setText(this.content.length > 0 ? this.content : t('modal.log.empty'));

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(t('modal.log.copy'))
          .setCta()
          .onClick(async () => {
            await (
              globalThis as { navigator: { clipboard: { writeText(s: string): Promise<void> } } }
            ).navigator.clipboard.writeText(this.content);
            new Notice(t('modal.log.copiedNotice'));
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t('settings.behavior.log.clear'))
          .setWarning()
          .onClick(async () => {
            await this.onClear();
            new Notice(t('settings.behavior.log.clearedNotice'));
            this.close();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
