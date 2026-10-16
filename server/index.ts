import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? 4000);
// Containers must accept traffic from outside the container, so production
// binds all interfaces. Local development keeps loopback to avoid exposing an
// unauthenticated dev database to the network.
const HOST =
  process.env.NODE_ENV === 'production'
    ? (process.env.HOST ?? '0.0.0.0')
    : (process.env.HOST ?? '127.0.0.1');

createApp()
  .then((app) => {
    app.listen(PORT, HOST, () => {
      console.log(`\n  Quest Lite API  →  http://${HOST}:${PORT}/api/health`);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`  Web dev server  →  http://127.0.0.1:5173  (npm run dev)\n`);
      }
    });
  })
  .catch((err) => {
    console.error('Failed to start Quest Lite:', err);
    process.exit(1);
  });
