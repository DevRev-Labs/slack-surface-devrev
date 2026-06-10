/**
 * Session GC — periodic sweep driven by cron-scheduled timer.tick events.
 *
 * Two passes per run:
 *   1. Idle sweep: sessions still `active` whose `expires_at_ms` has elapsed
 *      but whose `hard_expires_at_ms` has not. Mark them `expired` with
 *      reason `idle_timeout`. Records stay in DevRev until the absolute
 *      timeout passes.
 *   2. Hard sweep: any session whose `hard_expires_at_ms` has elapsed.
 *      Delete the session record from DevRev.
 *
 * The schedule itself comes from the manifest (timer-events with cron),
 * so the function does not self-schedule.
 */

import { LOG_TAG } from '../../config';
import { FunctionInput } from '../../types';
import { createLogger } from '../../utils/logger';
import {
  deleteSession,
  endSession,
  listHardExpiredSessions,
  listIdleExpiredSessions,
  SessionRecord,
  StoreConfig,
} from '../../utils/session-store';

async function runGc(event: FunctionInput): Promise<any> {
  const requestId = event.execution_metadata.request_id;
  const eventType = event.execution_metadata.event_type;
  const eventKey = (event.payload as any)?.event_key || (event.payload as any)?.metadata?.event_key || '';
  // Per-invocation logger for the GC subsystem.
  const log = createLogger(requestId, LOG_TAG.GC);

  log.info('tick received', {
    event_key: eventKey,
    event_type: eventType,
    received_at: new Date().toISOString(),
  });

  const config: StoreConfig = {
    devrevEndpoint: event.execution_metadata.devrev_endpoint.replace(/\/$/, ''),
    serviceAccountToken: event.context.secrets.service_account_token,
  };

  if (!config.devrevEndpoint || !config.serviceAccountToken) {
    log.warn('missing devrev config — endpoint or service account token absent');
    return { reason: 'missing devrev config', status: 'error' };
  }

  const now = Date.now();
  log.info('sweep starting', {
    devrev_endpoint: config.devrevEndpoint,
    now_iso: new Date(now).toISOString(),
  });

  // 1. Idle sweep — mark active-but-idle sessions expired.
  const idleSessions = await listIdleExpiredSessions(config, now).catch((error: any) => {
    log.warn('listIdleExpiredSessions failed', { err_message: error?.message || error });
    return [] as SessionRecord[];
  });
  log.info('idle sweep candidates', {
    count: idleSessions.length,
    ids: idleSessions.map((r) => r.objectId),
  });

  for (const record of idleSessions) {
    try {
      await endSession(config, record, 'idle_timeout');
      log.info('marked idle-expired', {
        expires_at: new Date(record.expiresAt).toISOString(),
        last_used_at: new Date(record.lastUsedAt).toISOString(),
        object_id: record.objectId,
        session_id: record.sessionId,
      });
    } catch (error: any) {
      log.warn('endSession(idle) failed', { err_message: error?.message || error, session_id: record.sessionId });
    }
  }

  // 2. Hard sweep — delete records past the absolute timeout.
  const hardSessions = await listHardExpiredSessions(config, now).catch((error: any) => {
    log.warn('listHardExpiredSessions failed', { err_message: error?.message || error });
    return [] as SessionRecord[];
  });
  log.info('hard sweep candidates', {
    count: hardSessions.length,
    ids: hardSessions.map((r) => r.objectId),
  });

  let sessionsDeleted = 0;
  for (const record of hardSessions) {
    if (!record.objectId) {
      log.info('skipping hard-expired record with no object id', { session_id: record.sessionId });
      continue;
    }
    await deleteSession(config, record);
    log.info('deleted hard-expired session', {
      end_reason: record.endReason,
      hard_expires_at: new Date(record.hardExpiresAt).toISOString(),
      object_id: record.objectId,
      session_id: record.sessionId,
      status: record.status,
    });
    sessionsDeleted += 1;
  }

  log.info('sweep complete', {
    duration_ms: Date.now() - now,
    idle_marked: idleSessions.length,
    sessions_deleted: sessionsDeleted,
  });

  return {
    idle_marked: idleSessions.length,
    sessions_deleted: sessionsDeleted,
    status: 'success',
  };
}

// Module-level GC logger for the outer run wrapper (no requestId yet).
const gcLog = createLogger(undefined, LOG_TAG.GC);

export const run = async (events: FunctionInput[]): Promise<any> => {
  gcLog.info('run invoked', { event_count: events.length });
  const results = await Promise.all(
    events.map((event) =>
      runGc(event).catch((error: any) => {
        gcLog.error('runGc threw', { err_message: error?.message || error });
        return {
          reason: error?.message || 'Unknown error',
          status: 'error',
        };
      })
    )
  );
  return results.length === 1 ? results[0] : results;
};

export default run;
