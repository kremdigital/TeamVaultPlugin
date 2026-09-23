import type { App } from 'obsidian';
import { ButtonComponent, Setting } from './__mocks__/obsidian';
import { ConfirmModal, confirmAction, confirmAnswer } from '@/ui/modals/confirm-modal';

describe('confirmAnswer', () => {
  it('answers yes on confirm', () => {
    const onAnswer = jest.fn<void, [boolean]>();
    confirmAnswer(onAnswer).confirm();
    expect(onAnswer.mock.calls).toEqual([[true]]);
  });

  it('answers no when the modal is dismissed (Cancel, Escape, ×, click outside)', () => {
    const onAnswer = jest.fn<void, [boolean]>();
    confirmAnswer(onAnswer).dismiss();
    expect(onAnswer.mock.calls).toEqual([[false]]);
  });

  it('keeps the yes when onClose follows the confirm button', () => {
    // The confirm button closes the modal, and Obsidian then runs onClose,
    // which dismisses: the removal must still go ahead.
    const onAnswer = jest.fn<void, [boolean]>();
    const answer = confirmAnswer(onAnswer);
    answer.confirm();
    answer.dismiss();
    expect(onAnswer.mock.calls).toEqual([[true]]);
  });

  it('answers only once, however often it is dismissed', () => {
    const onAnswer = jest.fn<void, [boolean]>();
    const answer = confirmAnswer(onAnswer);
    answer.dismiss();
    answer.dismiss();
    answer.confirm();
    expect(onAnswer.mock.calls).toEqual([[false]]);
  });
});

/**
 * The modal itself, on a mock `Modal` that behaves like Obsidian's: `close()`
 * runs `onClose` (tests/__mocks__/obsidian.ts).
 */
describe('ConfirmModal', () => {
  const app = {} as App;
  const options = { title: 'Remove server?', message: 'Remove "Work"?', confirmText: 'Remove' };

  /** The Cancel and confirm buttons of the modal opened last. */
  function buttons(): { cancel: ButtonComponent; confirm: ButtonComponent } {
    const [cancel, confirm] = Setting.buttons.slice(-2);
    if (!cancel || !confirm) throw new Error('the modal has not rendered its buttons');
    return { cancel, confirm };
  }

  beforeEach(() => {
    Setting.buttons = [];
  });

  it('answers yes on the confirm button, although closing then runs onClose', async () => {
    const answer = confirmAction(app, options);
    const { confirm } = buttons();
    expect(confirm.text).toBe('Remove');
    confirm.click();
    await expect(answer).resolves.toBe(true);
  });

  it('answers no on Cancel', async () => {
    const answer = confirmAction(app, options);
    buttons().cancel.click();
    await expect(answer).resolves.toBe(false);
  });

  it('answers no when closed any other way — Escape, ×, a click outside', () => {
    const onAnswer = jest.fn<void, [boolean]>();
    const modal = new ConfirmModal(app, options, onAnswer);
    modal.open();
    modal.close();
    expect(onAnswer.mock.calls).toEqual([[false]]);
  });

  it('puts the focus on the confirm button, so Enter confirms', () => {
    new ConfirmModal(app, options, jest.fn()).open();
    expect(buttons().confirm.focusSpy).toHaveBeenCalled();
  });

  it('answers once on a double click of the confirm button', () => {
    const onAnswer = jest.fn<void, [boolean]>();
    new ConfirmModal(app, options, onAnswer).open();
    const { confirm } = buttons();
    confirm.click();
    confirm.click();
    expect(onAnswer.mock.calls).toEqual([[true]]);
  });
});
