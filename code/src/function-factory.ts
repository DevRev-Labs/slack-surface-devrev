import slack_handler from './functions/slack_handler';
import slack_interactivity from './functions/slack_interactivity';
import ai_response_handler from './functions/ai_response_handler';
import ensure_session_state_schema from './functions/ensure_session_state_schema';
import session_gc from './functions/session_gc';

export const functionFactory = {
  slack_handler,
  slack_interactivity,
  ai_response_handler,
  ensure_session_state_schema,
  session_gc,
} as const;

export type FunctionFactoryType = keyof typeof functionFactory;
