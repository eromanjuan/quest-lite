import express, { type Express, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';

import { attachUser, rateLimit } from './auth/middleware.js';
import { SESSION_COOKIE } from './auth/session.js';
import { cors, configuredOrigins } from './core/cors.js';
import { getDb, DB_PATH } from './db/database.js';
import { logFirebaseStatus } from './db/firebase.js';
import { firestoreReady, flush, firestoreHealth } from './db/firestore-sync.js';
import { seedConfiguration, purgeDemoAccounts } from './db/seed.js';
import { handleError, notFoundHandler } from './http/helpers.js';

import { authRouter } from './routes/auth.js';
import { configRouter } from './routes/config.js';
import { companies as companiesRouter, contacts as contactsRouter, opportunities as opportunitiesRouter } from './routes/crm.js';
import { prospectingRouter } from './routes/prospecting.js';
import { tasksRouter } from './routes/tasks.js';
import { commsRouter } from './routes/comms.js';
import { bidsRouter } from './routes/bids.js';
import { estimatesRouter } from './routes/estimates.js';
import { dealsRouter } from './routes/deals.js';
import { productionRouter } from './routes/production.js';
import { dashboardRouter } from './routes/dashboard.js';
import { adminRouter } from './routes/admin.js';

export interface AppOptions {
  /** Serve the built SPA from dist/. Enabled automatically in production. */
  serveStatic?: boolean;
}

export async function createApp(options: AppOptions = {}): Promise<Express> {
  const app = express();
  app.set('trust proxy', true);

  // Cross-origin support must be registered before anything that can end a
  // request — preflight OPTIONS never reaches a route handler.
  app.use(cors());

  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use(attachUser());

  // Baseline security headers for the API surface.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const authLimiter = rateLimit({ windowMs: 60_000, max: 30, key: (r) => r.ip ?? 'anon' });
  const writeLimiter = rateLimit({ windowMs: 60_000, max: 240 });

  app.get('/api/health', (_req: Request, res: Response) => {
    const db = getDb();
    const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n;
    res.json({
      ok: true,
      db: path.basename(DB_PATH),
      users,
      // Reported so a split deployment — or a Firebase hiccup — can be
      // diagnosed from the client instead of guessed at.
      corsOrigins: configuredOrigins(),
      firestore: firestoreHealth(),
      time: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authLimiter, authRouter);
  app.use('/api', writeLimiter);
  app.use('/api/config', configRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api/opportunities', opportunitiesRouter);
  app.use('/api/prospects', prospectingRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/communications', commsRouter);
  app.use('/api/bids', bidsRouter);
  app.use('/api/estimates', estimatesRouter);
  app.use('/api/deals', dealsRouter);
  app.use('/api/projects', productionRouter.projects);
  app.use('/api/jobs', productionRouter.jobs);
  app.use('/api/change-orders', productionRouter.changeOrders);
  app.use('/api/invoices', productionRouter.invoices);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(handleError);

  const uploadDir = path.resolve(
    process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'data', 'uploads'),
  );
  fs.mkdirSync(uploadDir, { recursive: true });

  if (options.serveStatic ?? process.env.NODE_ENV === 'production') {
    const dist = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(dist)) {
      app.use(express.static(dist, { index: 'index.html', maxAge: '1h' }));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        res.sendFile(path.join(dist, 'index.html'), (err) => (err ? next() : undefined));
      });
    }
  }

  // Firestore is the database of record. Wait for the boot pull so the first
  // request already sees cloud state, then apply configuration and clean up
  // legacy demo accounts — both are mirrored back to Firebase by the sync
  // layer (see server/db/firestore-sync.ts).
  logFirebaseStatus();
  await firestoreReady();
  await seedConfiguration();
  const purged = purgeDemoAccounts();
  if (purged) console.log(`[seed] retired ${purged} legacy demo account(s).`);
  await flush();

  app.locals.sessionCookie = SESSION_COOKIE;
  return app;
}
