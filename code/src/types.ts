/**
 * Shared types for the Slack Surface snap-in.
 *
 * The shapes here mirror the runtime envelope DevRev hands to every snap-in
 * function via the platform `functionFactory` dispatcher. They're loose by
 * design (`payload: any`) because the same handler can be invoked for
 * unrelated event types — narrow at the call site, not here.
 */

/**
 * Envelope every snap-in function receives. DevRev populates this verbatim
 * before invoking the handler; the snap-in must not mutate it.
 *
 * - `payload` — event-specific body (Slack event, AI Agent response, …).
 * - `context` — execution context: org id, snap-in id, secrets bag.
 *   `secrets.service_account_token` is the snap-in's own machine token used
 *   for service-to-service DevRev API calls. Treat as sensitive.
 * - `execution_metadata` — invocation routing: a unique `request_id` for
 *   correlation in logs, the resolved function name, the event type and
 *   the regional DevRev API endpoint to call back into.
 * - `input_data` — manifest-derived inputs:
 *     * `global_values` — operator-supplied config (ai_agent_id, etc.)
 *     * `event_sources` — DON ids for any declared event sources
 *     * `keyrings` — third-party tokens (e.g. slack_bot_token)
 */
export interface FunctionInput {
  /** Event-specific payload. Type narrows in each handler. */
  payload: any;
  context: {
    /** DevRev org / dev-org id. */
    dev_oid: string;
    /** Originating event source DON. */
    source_id: string;
    /** This snap-in installation's id. */
    snap_in_id: string;
    /** Specific version of the snap-in being run. */
    snap_in_version_id: string;
    /** The snap-in's service account user id. */
    service_account_id: string;
    /** Secrets exposed by the platform (sensitive — never log). */
    secrets: {
      service_account_token: string;
      [key: string]: string;
    };
  };
  execution_metadata: {
    /** Unique per-invocation correlation id. Use in every log line. */
    request_id: string;
    /** Resolved function name (must match a `functionFactory` key). */
    function_name: string;
    /** Platform event-type label (e.g. `event:request:slack`). */
    event_type: string;
    /** Regional DevRev API endpoint, no trailing slash. */
    devrev_endpoint: string;
  };
  input_data: {
    /** Operator-supplied configuration values. */
    global_values: {
      ai_agent_id: string;
      [key: string]: string;
    };
    /** DON ids for any declared event sources. */
    event_sources: {
      [key: string]: string;
    };
    /** Third-party tokens / API keys. */
    keyrings: {
      [key: string]: string;
    };
  };
}
