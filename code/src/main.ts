import path from 'path';
import yargs from 'yargs';
// yargs publishes /helpers via its package "exports" map, which the
// import/no-unresolved rule (in eslint-plugin-import 2.32+) can't resolve.
// eslint-disable-next-line import/no-unresolved
import { hideBin } from 'yargs/helpers';

import { functionFactory, FunctionFactoryType } from './function-factory';
import { testRunner } from './test-runner/test-runner';
import { logger } from './utils/logger';

(async () => {
  const argv = await yargs(hideBin(process.argv)).options({
    fixturePath: {
      require: true,
      type: 'string',
    },
    functionName: {
      require: true,
      type: 'string',
    },
  }).argv;

  if (!argv.fixturePath || !argv.functionName) {
    logger.error('Missing required CLI arguments: fixturePath and/or functionName');
    process.exit(1);
  }

  const allowedFunctionNames = Object.keys(functionFactory) as FunctionFactoryType[];
  if (!allowedFunctionNames.includes(argv.functionName as FunctionFactoryType)) {
    logger.error('Invalid functionName', {
      allowed: allowedFunctionNames.join(', '),
      provided: argv.functionName,
    });
    process.exit(1);
  }

  // Restrict the fixture path to a basename so a crafted CLI argument cannot
  // traverse outside the fixtures directory and be passed to require().
  const safeFixturePath = path.basename(argv.fixturePath);

  await testRunner({
    fixturePath: safeFixturePath,
    functionName: argv.functionName as FunctionFactoryType,
  });
})();
