import { debounce } from '@/utils/debounce';
import { stubWindow } from './window-stub';

/** Hand-rolled deterministic timer queue — easier to reason about than
 *  jest.useFakeTimers when the test only needs explicit "advance to N". */
class FakeClock {
  now = 0;
  private id = 0;
  private timers = new Map<number, { fireAt: number; cb: () => void }>();

  setTimeout = (cb: () => void, ms: number): unknown => {
    const id = ++this.id;
    this.timers.set(id, { fireAt: this.now + ms, cb });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
    const due = [...this.timers.entries()].filter(([, t]) => t.fireAt <= this.now);
    for (const [id, t] of due) {
      this.timers.delete(id);
      t.cb();
    }
  }
}

describe('debounce', () => {
  it('fires once after the wait window', () => {
    const clock = new FakeClock();
    const fn = jest.fn();
    const d = debounce(fn, 100, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    d('a');
    expect(fn).not.toHaveBeenCalled();
    clock.advance(99);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('uses the latest arguments after a reset', () => {
    const clock = new FakeClock();
    const fn = jest.fn();
    const d = debounce(fn, 100, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    d('a');
    clock.advance(50);
    d('b');
    clock.advance(50);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(50);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('cancel() drops the pending call', () => {
    const clock = new FakeClock();
    const fn = jest.fn();
    const d = debounce(fn, 100, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    d('a');
    d.cancel();
    clock.advance(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flush() invokes immediately and clears the timer', () => {
    const clock = new FakeClock();
    const fn = jest.fn();
    const d = debounce(fn, 100, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    d('a');
    d.flush();
    expect(fn).toHaveBeenCalledWith('a');
    clock.advance(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() is a no-op when nothing is pending', () => {
    const clock = new FakeClock();
    const fn = jest.fn();
    const d = debounce(fn, 100, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('debounce — default timers', () => {
  it('schedules on window.setTimeout when no clock is injected', () => {
    // Popout-window compatibility: window.*, not the bare globals.
    const win = stubWindow();
    try {
      const fn = jest.fn();
      const d = debounce(fn, 100);
      d('a');
      d('b');
      expect(win.setTimeout.mock.calls.map(([, ms]) => ms)).toEqual([100, 100]);
      expect(win.clearTimeout).toHaveBeenCalledTimes(1);
      d.cancel();
      expect(win.clearTimeout).toHaveBeenCalledTimes(2);
    } finally {
      win.restore();
    }
  });
});
