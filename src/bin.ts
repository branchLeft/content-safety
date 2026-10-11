import { runMain } from './main.js';

const code = await runMain(process.argv.slice(2), process.env, {
  write: (line) => process.stdout.write(`${line}\n`),
  waitForStop: () =>
    new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    }),
});
process.exit(code);
