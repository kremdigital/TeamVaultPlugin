/**
 * Minimal Obsidian API mock for Jest. Only the surface area the plugin
 * actually uses gets stubbed here — extend as new symbols are needed.
 *
 * Real plugin code never imports from this file directly; jest.config maps
 * `import 'obsidian'` to it.
 */

export class Plugin {
  app: unknown;
  manifest: unknown;
  constructor(app: unknown, manifest: unknown) {
    this.app = app;
    this.manifest = manifest;
  }
  async onload(): Promise<void> {}
  async onunload(): Promise<void> {}
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(_data: unknown): Promise<void> {}
  addCommand(_command: unknown): unknown {
    return _command;
  }
  addSettingTab(_tab: unknown): void {}
  addStatusBarItem(): HTMLElement {
    return {} as HTMLElement;
  }
  registerEvent(_event: unknown): void {}
  registerView(_type: string, _factory: unknown): void {}
}

export class WorkspaceLeaf {}

export class ItemView {
  leaf: WorkspaceLeaf;
  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
  }
}

export class Menu {
  addItem(_build: unknown): this {
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_event: unknown): void {}
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl: HTMLElement = {} as HTMLElement;
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
  hide(): void {}
}

/** An element that swallows the few DOM helpers modals call. */
function fakeEl(): HTMLElement {
  const el = {
    empty: () => undefined,
    setText: () => undefined,
    createEl: () => fakeEl(),
  };
  return el as unknown as HTMLElement;
}

/**
 * Like Obsidian's: `open()` runs `onOpen`, `close()` runs `onClose` — once,
 * and only while the modal is open. Every way of closing it (a button,
 * Escape, ×, a click outside) ends in that same `close()`.
 */
export class Modal {
  app: unknown;
  contentEl: HTMLElement = fakeEl();
  titleEl: HTMLElement = fakeEl();
  private shown = false;
  constructor(app: unknown) {
    this.app = app;
  }
  open(): void {
    this.shown = true;
    this.onOpen();
  }
  close(): void {
    if (!this.shown) return;
    this.shown = false;
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class ButtonComponent {
  /** What `buttonEl.focus()` calls — a spy tests can assert on. */
  readonly focusSpy = jest.fn();
  buttonEl = { focus: this.focusSpy } as unknown as HTMLButtonElement;
  text = '';
  private clickHandler: (() => unknown) | null = null;
  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  setWarning(): this {
    return this;
  }
  onClick(handler: () => unknown): this {
    this.clickHandler = handler;
    return this;
  }
  /** Test helper: what a click on the button does. */
  click(): void {
    void this.clickHandler?.();
  }
}

export class Setting {
  /** Every button any `Setting` made, in order, for tests to click. */
  static buttons: ButtonComponent[] = [];
  constructor(_containerEl: unknown) {}
  addButton(build: (button: ButtonComponent) => unknown): this {
    const button = new ButtonComponent();
    Setting.buttons.push(button);
    build(button);
    return this;
  }
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export class TFile {
  path = '';
  name = '';
  basename = '';
  extension = '';
}

export class TFolder {
  path = '';
  name = '';
  children: Array<TFile | TFolder> = [];
}

export const requestUrl = jest.fn();
export const setIcon = jest.fn();
// A current Obsidian by default; tests of older builds override it per call.
export const requireApiVersion = jest.fn((_version: string) => true);
export const getLanguage = jest.fn(() => 'en');
export const debounce = <T extends (...args: never[]) => unknown>(fn: T, _wait: number): T => fn;
