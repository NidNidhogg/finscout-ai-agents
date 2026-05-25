import * as fs from 'fs';
import type Database from 'better-sqlite3';

interface FinscoutTelemetry {
  status: string;
  scouted_24h: number;
  high_value_leads: number;
  scheduled_calls: number;
}

interface DashboardState {
  timestamp: string;
  finscout: FinscoutTelemetry;
  [key: string]: unknown;
}

/**
 * Writes a telemetry snapshot of the FinScout pipeline into the mywfo-dashboard
 * state file. All errors are caught and logged — this must never crash the caller.
 */
export class OrchestratorService {
  private static readonly TARGET_STATE_PATH =
    '/Users/dmitriybelenkiy/dev/mywfo-dashboard/state.json';

  public static syncTelemetry(status: string, db: Database.Database): void {
    try {
      // Use a JS-computed ISO cutoff so both sides of the comparison share the
      // same format (JS ISO strings stored in enqueued_at vs SQLite datetime()).
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const scouted24h = (
        db
          .prepare<[string], { count: number }>(
            `SELECT COUNT(*) as count FROM queue_items WHERE enqueued_at >= ?`,
          )
          .get(since24h) ?? { count: 0 }
      ).count;

      // High-value = reviewed items that passed ICP scoring at Tier A or B.
      // Tier C leads are discarded by enrich-pending before reaching 'reviewed'.
      const highValueLeads = (
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) as count FROM queue_items
             WHERE status = 'reviewed'
               AND json_extract(annotation_json, '$.tier') IN ('A', 'B')`,
          )
          .get() ?? { count: 0 }
      ).count;

      // Drafted = agent has written an email; item is awaiting human approval.
      const scheduledCalls = (
        db
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) as count FROM queue_items WHERE status = 'drafted'`,
          )
          .get() ?? { count: 0 }
      ).count;

      const defaultState: DashboardState = {
        timestamp: 'INIT',
        finscout: { status: 'UNKNOWN', scouted_24h: 0, high_value_leads: 0, scheduled_calls: 0 },
      };

      const currentState: DashboardState = fs.existsSync(this.TARGET_STATE_PATH)
        ? (JSON.parse(fs.readFileSync(this.TARGET_STATE_PATH, 'utf8')) as DashboardState)
        : defaultState;

      currentState.timestamp =
        new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

      currentState.finscout = {
        status,
        scouted_24h: scouted24h,
        high_value_leads: highValueLeads,
        scheduled_calls: scheduledCalls,
      };

      fs.writeFileSync(this.TARGET_STATE_PATH, JSON.stringify(currentState, null, 2), 'utf8');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WFO_TELEMETRY_ERROR] Non-fatal sync error: ${message}`);
    }
  }
}
