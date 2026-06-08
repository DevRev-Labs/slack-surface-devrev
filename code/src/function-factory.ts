import ai_response_handler from './functions/ai_response_handler';
import ensure_session_state_schema from './functions/ensure_session_state_schema';
import session_gc from './functions/session_gc';
import slack_handler from './functions/slack_handler';
import slack_interactivity from './functions/slack_interactivity';

export const functionFactory = {
  ai_response_handler,
  ensure_session_state_schema,
  session_gc,
  slack_handler,
  slack_interactivity,
} as const;

export type FunctionFactoryType = keyof typeof functionFactory;
