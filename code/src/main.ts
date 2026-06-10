import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { functionFactory, FunctionFactoryType } from './function-factory';
import { testRunner } from './test-runner/test-runner';

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
    console.error('Please make sure you have passed fixturePath & functionName');
    process.exit(1);
  }

  const allowedFunctionNames = Object.keys(functionFactory) as FunctionFactoryType[];
  if (!allowedFunctionNames.includes(argv.functionName as FunctionFactoryType)) {
    console.error(`Invalid functionName: "${argv.functionName}". Allowed values: ${allowedFunctionNames.join(', ')}`);
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
