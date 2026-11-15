import { startServer } from './app';

// Log and carry on: one bad message or a failed lookup should never end everyone's race.
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection', reason));
process.on('uncaughtException', (error) => console.error('[server] uncaught exception', error));

const port = Number(process.env.PORT ?? 2567);

startServer(port).then(
  () => console.log(`[server] rooms listening on :${port}`),
  (error) => {
    console.error('[server] failed to start', error);
    process.exit(1);
  },
);
