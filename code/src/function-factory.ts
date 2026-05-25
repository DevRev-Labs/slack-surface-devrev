import slack_handler from './functions/slack_handler';
import ai_response_handler from './functions/ai_response_handler';
import ensure_session_state_schema from './functions/ensure_session_state_schema';

export const functionFactory = {
  slack_handler,
  ai_response_handler,
  ensure_session_state_schema,
} as const;

export type FunctionFactoryType = keyof typeof functionFactory;
