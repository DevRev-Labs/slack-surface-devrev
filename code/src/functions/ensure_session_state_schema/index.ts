import { client } from '@devrev/typescript-sdk';
import {
  CustomSchemaFragmentsSetRequest,
  CustomSchemaFragmentsSetRequestType,
  SchemaFieldDescriptor,
} from '@devrev/typescript-sdk/dist/auto-generated/beta/beta-devrev-sdk';
import { FunctionInput } from '../../types';
import {
  SESSION_LEAF_TYPE,
  SESSION_LEAF_TYPE_DESCRIPTION,
  SESSION_LEAF_TYPE_ID_PREFIX,
} from '../../utils/session-config';
import {
  SESSION_FIELD_SPECS,
  SchemaFieldSpec,
} from '../../utils/session-fields';

interface SchemaSpec {
  leaf_type: string;
  description: string;
  id_prefix: string;
  fields: SchemaFieldSpec[];
}

const SCHEMAS: SchemaSpec[] = [
  {
    leaf_type: SESSION_LEAF_TYPE,
    description: SESSION_LEAF_TYPE_DESCRIPTION,
    id_prefix: SESSION_LEAF_TYPE_ID_PREFIX,
    fields: SESSION_FIELD_SPECS,
  },
];

function toSchemaFieldDescriptor(spec: SchemaFieldSpec): SchemaFieldDescriptor {
  return {
    name: spec.name,
    field_type: spec.field_type as any,
    is_required: spec.is_required ?? false,
    is_filterable: spec.is_filterable ?? false,
    is_immutable: spec.is_immutable ?? false,
  } as SchemaFieldDescriptor;
}

async function ensureSessionStateSchema(event: FunctionInput): Promise<any> {
  const requestId = event.execution_metadata.request_id;
  const eventType = event.execution_metadata.event_type;

  if (eventType !== 'hook:snap_in_activate') {
    return { status: 'ignored', reason: `Unsupported event type: ${eventType}` };
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
      type: CustomSchemaFragmentsSetRequestType.TenantFragment,
      leaf_type: spec.leaf_type,
      is_custom_leaf_type: true,
      description: spec.description,
      id_prefix: spec.id_prefix,
      fields: spec.fields.map(toSchemaFieldDescriptor),
    };

    try {
      const response = await devrevSdk.customSchemaFragmentsSet(payload);
      console.log(`[${requestId}] Ensured schema`, {
        leafType: spec.leaf_type,
        schemaId: response.data?.id || '',
      });
      results.push({
        leaf_type: spec.leaf_type,
        status: 'success',
        schema_id: response.data?.id,
      });
    } catch (error: any) {
      hadError = true;
      console.error(
        `[${requestId}] Failed to ensure schema ${spec.leaf_type}:`,
        error?.response?.data || error?.message || error
      );
      results.push({
        leaf_type: spec.leaf_type,
        status: 'error',
        error: error?.message || 'Unknown error',
      });
    }
  }

  if (!hadError) {
    return {
      status: 'active',
      schemas: results,
    };
  } else {
    const firstError = results.find((r) => r.status === 'error');
    return {
      status: 'error',
      reason: 'Failed to ensure session state schema',
      details: firstError?.error || 'Unknown error',
      schemas: results,
    };
  }
}

export const run = async (events: FunctionInput[]): Promise<any> => {
  const results = await Promise.all(
    events.map(async (event) => ensureSessionStateSchema(event))
  );

  return results.length === 1 ? results[0] : results;
};

export default run;
