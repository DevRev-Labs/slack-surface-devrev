import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

import { functionFactory, FunctionFactoryType } from '../function-factory';
import { logger } from '../utils/logger';

export interface TestRunnerProps {
  functionName: FunctionFactoryType;
  fixturePath: string;
}

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SAFE_FIXTURE_NAME = /^[A-Za-z0-9_.-]+$/;

export const testRunner = async ({ functionName, fixturePath }: TestRunnerProps) => {
  //Since we were not using the env anywhere its not require to load it
  dotenv.config();

  if (!functionFactory[functionName]) {
    logger.error('Function not found in functionFactory', {
      functionName,
      hint: 'Register the function in src/function-factory.ts',
    });
    throw new Error('Function is not found in the functionFactory');
  }

  const run = functionFactory[functionName];

  // Reject path-separators / traversal sequences before resolving so a
  // crafted fixturePath cannot escape the fixtures directory or be loaded
  // as executable code.
  const baseName = path.basename(fixturePath);
  if (baseName !== fixturePath || !SAFE_FIXTURE_NAME.test(baseName) || baseName.startsWith('.')) {
    throw new Error(`Invalid fixture name: ${fixturePath}`);
  }

  const fileName = baseName.endsWith('.json') ? baseName : `${baseName}.json`;
  const resolved = path.resolve(FIXTURES_DIR, fileName);
  if (path.dirname(resolved) !== FIXTURES_DIR) {
    throw new Error(`Fixture path escapes fixtures directory: ${fixturePath}`);
  }

  // Read fixtures via fs + JSON.parse rather than require() so the user
  // input never reaches a code-execution sink.
  const eventFixture = JSON.parse(fs.readFileSync(resolved, 'utf8'));

  await run(eventFixture);
};
