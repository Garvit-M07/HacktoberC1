// Firebase entry point: Hosting serves /public, and every /api/** request is
// rewritten to this Cloud Function, which runs the same handler as server.js.
import { onRequest } from 'firebase-functions/v2/https';

process.env.NETX_NO_LISTEN = '1';
const ready = import('./server.js'); // loads env.local + Firestore data once per instance

export const api = onRequest(
  {
    region: 'us-central1',
    maxInstances: 1,        // data is cached in memory, so keep a single instance
    minInstances: 0,
    cpu: 1,                 // required for concurrency > 1
    concurrency: 80,
    memory: '512MiB',
    timeoutSeconds: 120,    // Gemma calls can take a while
  },
  async (req, res) => {
    const { handler } = await ready;
    return handler(req, res);
  },
);
