import { client } from '@devrev/typescript-sdk';
import {
  CustomSchemaFragmentsSetRequest,
  CustomSchemaFragmentsSetRequestType,
  SchemaFieldDescriptor,
} from '@devrev/typescript-sdk/dist/auto-generated/beta/beta-devrev-sdk';

import { LOG_TAG } from '../../config';
import { FunctionInput } from '../../types';
import { createLogger } from '../../utils/logger';
import { SESSION_LEAF_TYPE, SESSION_LEAF_TYPE_DESCRIPTION } from '../../utils/session-config';
import { SchemaFieldSpec, SESSION_FIELD_SPECS } from '../../utils/session-fields';

// Tenant-fragment schema attached to the built-in `conversation` leaf type so
// every conversation in the dev org carries the Slack session fields.
interface SchemaSpec {
  leaf_type: string;
  description: string;
  fields: SchemaFieldSpec[];
}

const SCHEMAS: SchemaSpec[] = [
  {
    description: SESSION_LEAF_TYPE_DESCRIPTION,
    fields: SESSION_FIELD_SPECS,
    leaf_type: SESSION_LEAF_TYPE,
  },
];

function toSchemaFieldDescriptor(spec: SchemaFieldSpec): SchemaFieldDescriptor {
  return {
    field_type: spec.field_type as any,
    is_filterable: spec.is_filterable ?? false,
    is_immutable: spec.is_immutable ?? false,
    is_required: spec.is_required ?? false,
    name: spec.name,
  } as SchemaFieldDescriptor;
}

async function ensureSessionStateSchema(event: FunctionInput): Promise<any> {
  const requestId = event.execution_metadata.request_id;
  const eventType = event.execution_metadata.event_type;

  if (eventType !== 'hook:snap_in_activate') {
    return { reason: `Unsupported event type: ${eventType}`, status: 'ignored' };
  }

  const devrevEndpoint = event.execution_metadata.devrev_endpoint.replace(/\/$/, '');
  const serviceAccountToken = event.context.secrets.service_account_token;

  const devrevSdk = client.setupBeta({
    endpoint: devrevEndpoint,
    token: serviceAccountToken,
  });

  const results: Array<{ leaf_type: string; status: string; schema_id?: string; error?: string }> = [];
  let hadError = false;

  for (const spec of SCHEMAS) {
    const payload: CustomSchemaFragmentsSetRequest = {
      description: spec.description,
      fields: spec.fields.map(toSchemaFieldDescriptor),
      is_custom_leaf_type: false,
      leaf_type: spec.leaf_type,
      type: CustomSchemaFragmentsSetRequestType.TenantFragment,
    };

    const log = createLogger(requestId, LOG_TAG.CONFIG);
    try {
      const response = await devrevSdk.customSchemaFragmentsSet(payload);
      log.info('Ensured schema', {
        leaf_type: spec.leaf_type,
        schema_id: response.data?.id || '',
      });
      results.push({
        leaf_type: spec.leaf_type,
        schema_id: response.data?.id,
        status: 'success',
      });
    } catch (error: any) {
      hadError = true;
      log.error('Failed to ensure schema', {
        err_data: error?.response?.data,
        err_message: error?.message || error,
        leaf_type: spec.leaf_type,
      });
      results.push({
        error: error?.message || 'Unknown error',
        leaf_type: spec.leaf_type,
        status: 'error',
      });
    }
  }

  if (!hadError) {
    return {
      schemas: results,
      status: 'active',
    };
  } else {
    const firstError = results.find((r) => r.status === 'error');
    return {
      details: firstError?.error || 'Unknown error',
      reason: 'Failed to ensure session state schema',
      schemas: results,
      status: 'error',
    };
  }
}

export const run = async (events: FunctionInput[]): Promise<any> => {
  const results = await Promise.all(events.map(async (event) => ensureSessionStateSchema(event)));

  return results.length === 1 ? results[0] : results;
};

export default run;
