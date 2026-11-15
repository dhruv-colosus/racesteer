import { startServer } from './app';

const port = Number(process.env.PORT ?? 2567);

startServer(port).then(
  () => console.log(`[server] rooms listening on :${port}`),
  (error) => {
    console.error('[server] failed to start', error);
    process.exit(1);
  },
);
