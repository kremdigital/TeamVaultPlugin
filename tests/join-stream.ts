/**
 * The answer to `project:join` as the server gives it, for the fake sockets
 * of the tests: the operations in the answer, the text docs after it, as
 * `yjs:catchup` batches (`sync-protocol.md`, «Подключение»). The server
 * stopped putting the docs into the answer (`yjsDocs`); the engine no longer
 * reads them there.
 */
import type { YjsCatchupBatch, YjsDocSnapshot } from '@/client/socket';

/** How many docs the server puts in one `yjs:catchup` batch (`YJS_CATCHUP_BATCH`). */
export const CATCHUP_BATCH = 20;

/**
 * The docs a `FakeServer.joinAnswer` answer streams after it. A property the
 * engine never sees, and not enumerable: an answer a test spreads into its
 * own (`{ ...server.joinAnswer(…), yjsStream: true }`) leaves it out, and
 * the test streams the docs itself.
 */
export const STREAMED = Symbol('docs streamed after the join answer');

/** `answer` carrying `docs` as {@link STREAMED}. */
export function withStreamed<T extends object>(answer: T, docs: YjsDocSnapshot[]): T {
  Object.defineProperty(answer, STREAMED, { value: docs, enumerable: false });
  return answer;
}

/** `docs` in the batches the server streams them in; one `done` batch with none. */
export function catchupBatches(projectId: string, docs: YjsDocSnapshot[]): YjsCatchupBatch[] {
  if (docs.length === 0) return [{ projectId, docs: [], done: true }];
  const batches: YjsCatchupBatch[] = [];
  for (let i = 0; i < docs.length; i += CATCHUP_BATCH) {
    batches.push({
      projectId,
      docs: docs.slice(i, i + CATCHUP_BATCH),
      done: i + CATCHUP_BATCH >= docs.length,
    });
  }
  return batches;
}

/**
 * What the server sends for `response`, the answer a test gives to a join of
 * `projectId`: the answer, and the `yjs:catchup` batches that follow it.
 *
 * - `yjsDocs` in `response` is the tests' shorthand for the docs the server
 *   has: they are streamed, and the answer says `yjsStream` and `yjsCount`.
 * - An answer of `FakeServer.joinAnswer` is sent as it is, and its docs
 *   ({@link STREAMED}) are streamed.
 * - An answer that says `yjsStream` or `yjsSkipped` itself is sent as it
 *   is: the test streams the docs, or there are none.
 * - Any other answer that took the join: no docs — the answer says
 *   `yjsStream` and `yjsCount: 0`, and one `done` batch follows.
 * - A refusal: as it is, nothing follows.
 */
export function serverJoin(
  response: unknown,
  projectId: string,
): { answer: unknown; batches: YjsCatchupBatch[] } {
  if (typeof response !== 'object' || response === null) return { answer: response, batches: [] };
  const r = response as Record<string, unknown> & { [STREAMED]?: YjsDocSnapshot[] };
  if (r.ok !== true) return { answer: response, batches: [] };
  if ('yjsDocs' in r) {
    const { yjsDocs, ...rest } = r;
    const docs = Array.isArray(yjsDocs) ? (yjsDocs as YjsDocSnapshot[]) : [];
    return {
      answer: { ...rest, yjsStream: true, yjsCount: docs.length },
      batches: catchupBatches(projectId, docs),
    };
  }
  const streamed = r[STREAMED];
  if (streamed !== undefined) {
    return { answer: { ...r }, batches: catchupBatches(projectId, streamed) };
  }
  if ('yjsStream' in r || 'yjsSkipped' in r) return { answer: response, batches: [] };
  return {
    answer: { ...r, yjsStream: true, yjsCount: 0 },
    batches: catchupBatches(projectId, []),
  };
}

/** The `projectId` of a `project:join` payload; `''` when it has none. */
export function joinProjectId(payload: unknown): string {
  const id = (payload as { projectId?: unknown } | null)?.projectId;
  return typeof id === 'string' ? id : '';
}
