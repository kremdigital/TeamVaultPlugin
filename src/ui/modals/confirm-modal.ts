import { type App, type ButtonComponent, Modal, Setting } from 'obsidian';
import { t } from '@/i18n';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label of the destructive button, e.g. "Remove". */
  confirmText: string;
}

/**
 * The yes/no answer of one confirmation, settled exactly once. `confirm()`
 * answers yes; `dismiss()` — Cancel, Escape, the × button, a click outside —
 * answers no. Whatever comes later is ignored: Obsidian runs `onClose` after
 * the confirm button closes the modal too, and that must not turn the yes
 * into a no.
 */
export interface ConfirmAnswer {
  confirm(): void;
  dismiss(): void;
}

export function confirmAnswer(onAnswer: (confirmed: boolean) => void): ConfirmAnswer {
  let settled = false;
  const settle = (confirmed: boolean): void => {
    if (settled) return;
    settled = true;
    onAnswer(confirmed);
  };
  return { confirm: () => settle(true), dismiss: () => settle(false) };
}

/**
 * Confirmation on Obsidian's own `Modal`, in place of `window.confirm` — the
 * native dialog blocks the whole window, ignores the app theme and is what
 * the directory's linter flags (`no-alert`).
 *
 * Keys work as in Obsidian's own confirmations: the confirm button has the
 * focus, so Enter confirms and Tab reaches Cancel; Escape closes the modal,
 * which answers no.
 */
export class ConfirmModal extends Modal {
  private readonly answer: ConfirmAnswer;
  private confirmButton: ButtonComponent | null = null;

  constructor(
    app: App,
    private readonly options: ConfirmOptions,
    onAnswer: (confirmed: boolean) => void,
  ) {
    super(app);
    this.answer = confirmAnswer(onAnswer);
  }

  override open(): void {
    super.open();
    // Obsidian focuses the first button once `onOpen` has run — Cancel here.
    this.confirmButton?.buttonEl.focus();
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.options.title);
    contentEl.createEl('p', { text: this.options.message });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t('modal.confirm.cancel')).onClick(() => {
          this.answer.dismiss();
          this.close();
        }),
      )
      .addButton((btn) => {
        this.confirmButton = btn;
        btn
          .setButtonText(this.options.confirmText)
          .setWarning()
          .onClick(() => {
            this.answer.confirm();
            this.close();
          });
      });
  }

  override onClose(): void {
    this.answer.dismiss();
    this.contentEl.empty();
  }
}

/** Ask, and resolve with the answer once the modal closes. */
export function confirmAction(app: App, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, options, resolve).open();
  });
}
