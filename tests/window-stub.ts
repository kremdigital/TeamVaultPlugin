/**
 * Swap `window` for a stand-in for the duration of one test.
 *
 * Under Jest `window` is the global object (tests/setup-window.ts), so a spy
 * on `window.setTimeout` could not tell it from the bare `setTimeout` the code
 * called before. The stand-in is a separate object: its timers are spies that
 * still run on the real clock, `crypto` is the real one unless overridden,
 * and code that bypasses `window` never touches it.
 */
export interface WindowStub {
  setTimeout: jest.Mock<unknown, [() => void, number?]>;
  clearTimeout: jest.Mock<void, [unknown]>;
  restore(): void;
}

export function stubWindow(overrides: Record<string, unknown> = {}): WindowStub {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const setTimeoutSpy = jest.fn<unknown, [() => void, number?]>((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutSpy = jest.fn<void, [unknown]>((handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  });
  const stand = {
    setTimeout: setTimeoutSpy,
    clearTimeout: clearTimeoutSpy,
    crypto: globalThis.crypto,
    ...overrides,
  };
  Object.defineProperty(globalThis, 'window', {
    value: stand,
    writable: true,
    configurable: true,
  });
  return {
    setTimeout: setTimeoutSpy,
    clearTimeout: clearTimeoutSpy,
    restore: () => {
      if (original) Object.defineProperty(globalThis, 'window', original);
      else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}
