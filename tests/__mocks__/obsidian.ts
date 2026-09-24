/**
 * Minimal Obsidian API mock for Jest. Only the surface area the plugin
 * actually uses gets stubbed here — extend as new symbols are needed.
 *
 * Real plugin code never imports from this file directly; jest.config maps
 * `import 'obsidian'` to it.
 */

interface MockAdapter {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

function pluginAdapter(plugin: Plugin): MockAdapter | null {
  const app = plugin.app as { vault?: { adapter?: MockAdapter } } | null;
  return app?.vault?.adapter ?? null;
}

function pluginDataPath(plugin: Plugin): string {
  const manifest = plugin.manifest as { dir?: string; id?: string } | null;
  return `${manifest?.dir ?? `.obsidian/plugins/${manifest?.id ?? ''}`}/data.json`;
}

export class Plugin {
  app: unknown;
  manifest: unknown;
  constructor(app: unknown, manifest: unknown) {
    this.app = app;
    this.manifest = manifest;
  }
  async onload(): Promise<void> {}
  async onunload(): Promise<void> {}
  /**
   * Like Obsidian's `Vault.readJson` (app.js 1.13.7) when the app carries a
   * vault adapter: `null` for a missing `data.json`, `undefined` for any
   * other failure, a parse error included. `null` without an adapter.
   */
  async loadData(): Promise<unknown> {
    const adapter = pluginAdapter(this);
    if (!adapter) return null;
    try {
      return JSON.parse(await adapter.read(pluginDataPath(this)));
    } catch (err) {
      return (err as { code?: string } | null)?.code === 'ENOENT' ? null : undefined;
    }
  }
  async saveData(data: unknown): Promise<void> {
    const adapter = pluginAdapter(this);
    if (adapter) await adapter.write(pluginDataPath(this), JSON.stringify(data, undefined, 2));
  }
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
  containerEl: HTMLElement = fakeEl();
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
  hide(): void {}
}

/** An element that swallows the few DOM helpers modals and the settings tab call. */
function fakeEl(): HTMLElement {
  const el = {
    empty: () => undefined,
    setText: () => undefined,
    createEl: () => fakeEl(),
    createDiv: () => fakeEl(),
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
  disabled = false;
  private clickHandler: (() => unknown) | null = null;
  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  setWarning(): this {
    return this;
  }
  setCta(): this {
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
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

/** A dropdown, text field or toggle: takes the calls, keeps nothing. */
class InputComponent {
  addOption(_value: string, _display: string): this {
    return this;
  }
  setValue(_value: unknown): this {
    return this;
  }
  setPlaceholder(_placeholder: string): this {
    return this;
  }
  setDisabled(_disabled: boolean): this {
    return this;
  }
  onChange(_handler: (value: never) => unknown): this {
    return this;
  }
}

export class Setting {
  /** Every button any `Setting` made, in order, for tests to click. */
  static buttons: ButtonComponent[] = [];
  /** Every `Setting` made, in order, for tests to look at. */
  static all: Setting[] = [];
  name = '';
  desc = '';
  /** This setting's own buttons, in order. */
  readonly settingButtons: ButtonComponent[] = [];
  constructor(_containerEl: unknown) {
    Setting.all.push(this);
  }
  setName(name: string): this {
    this.name = name;
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }
  setHeading(): this {
    return this;
  }
  addButton(build: (button: ButtonComponent) => unknown): this {
    const button = new ButtonComponent();
    Setting.buttons.push(button);
    this.settingButtons.push(button);
    build(button);
    return this;
  }
  addDropdown(build: (dropdown: InputComponent) => unknown): this {
    build(new InputComponent());
    return this;
  }
  addText(build: (text: InputComponent) => unknown): this {
    build(new InputComponent());
    return this;
  }
  addToggle(build: (toggle: InputComponent) => unknown): this {
    build(new InputComponent());
    return this;
  }
}

export class Notice {
  /** Every notice shown, in order — for tests to assert on. */
  static shown: Array<{ message: string; timeout: number | undefined }> = [];
  constructor(message: string, timeout?: number) {
    Notice.shown.push({ message, timeout });
  }
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
