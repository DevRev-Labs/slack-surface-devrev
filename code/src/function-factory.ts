import slack_handler from './functions/slack_handler';
import ai_response_handler from './functions/ai_response_handler';

export const functionFactory = {
  slack_handler,
  ai_response_handler,
} as const;

export type FunctionFactoryType = keyof typeof functionFactory;
