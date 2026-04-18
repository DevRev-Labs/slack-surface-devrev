/**
 * Shared types for the Slack AI Integration snap-in
 */

export interface FunctionInput {
  payload: any;
  context: {
    dev_oid: string;
    source_id: string;
    snap_in_id: string;
    snap_in_version_id: string;
    service_account_id: string;
    secrets: {
      service_account_token: string;
      [key: string]: string;
    };
  };
  execution_metadata: {
    request_id: string;
    function_name: string;
    event_type: string;
    devrev_endpoint: string;
  };
  input_data: {
    global_values: {
      ai_agent_id: string;
      [key: string]: string;
    };
    event_sources: {
      [key: string]: string;
    };
    keyrings: {
      [key: string]: string;
    };
  };
}
