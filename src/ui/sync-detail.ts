import { JOIN_FAILED } from '@/client/socket';
import { t } from '@/i18n';

/**
 * A status detail an engine reports (see `SyncEngine.onStatus`) as the user
 * reads it, in the status bar and in the error notice: in words for a code
 * that would otherwise leave the user guessing whether to act, the detail
 * itself for the rest.
 */
export function describeSyncDetail(detail: string): string {
  switch (detail) {
    case JOIN_FAILED:
      // The engine joins again on its own (see `SyncEngine.joinAgainLater`).
      return t('status.detail.joinFailed');
    default:
      return detail;
  }
}
