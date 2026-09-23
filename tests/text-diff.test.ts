import * as Y from 'yjs';
import { applyTextDiff } from '@/crdt/text-diff';

function newDoc(): { doc: Y.Doc; ytext: Y.Text } {
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  return { doc, ytext };
}

describe('applyTextDiff', () => {
  it('is a no-op when contents already match', () => {
    const { doc, ytext } = newDoc();
    ytext.insert(0, 'hello');
    let updates = 0;
    doc.on('update', () => updates++);
    applyTextDiff(ytext, 'hello');
    expect(updates).toBe(0);
  });

  it('inserts new content into an empty doc', () => {
    const { ytext } = newDoc();
    applyTextDiff(ytext, 'hello world');
    expect(ytext.toJSON()).toBe('hello world');
  });

  it('replaces middle of the text minimally', () => {
    const { ytext } = newDoc();
    ytext.insert(0, 'the quick brown fox');
    applyTextDiff(ytext, 'the quick green fox');
    expect(ytext.toJSON()).toBe('the quick green fox');
  });

  it('removes content', () => {
    const { ytext } = newDoc();
    ytext.insert(0, 'hello world');
    applyTextDiff(ytext, 'hello');
    expect(ytext.toJSON()).toBe('hello');
  });

  it('handles full replacement', () => {
    const { ytext } = newDoc();
    ytext.insert(0, 'foo');
    applyTextDiff(ytext, 'bar');
    expect(ytext.toJSON()).toBe('bar');
  });

  it('forwards origin to the transact() call', () => {
    const { doc, ytext } = newDoc();
    ytext.insert(0, 'a');
    const ORIGIN = Symbol('test-origin');
    let seen: unknown = null;
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      seen = origin;
    });
    applyTextDiff(ytext, 'ab', ORIGIN);
    expect(seen).toBe(ORIGIN);
  });

  it('produces a single transact across multiple diff parts', () => {
    const { doc, ytext } = newDoc();
    ytext.insert(0, 'hello world');
    let updates = 0;
    doc.on('update', () => updates++);
    applyTextDiff(ytext, 'HELLO WORLD');
    expect(updates).toBe(1);
  });

  it('keeps Y.Text contents valid for non-ASCII', () => {
    const { ytext } = newDoc();
    ytext.insert(0, 'привет');
    applyTextDiff(ytext, 'привет, мир');
    expect(ytext.toJSON()).toBe('привет, мир');
  });
});
