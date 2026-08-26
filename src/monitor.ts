import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import express = require('express');
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { redisConnection } from './config';
import { ORDER_QUEUE } from './orders/orders.service';

const app = express();
const serverAdapter = new ExpressAdapter();
const queue = new Queue(ORDER_QUEUE, { connection: redisConnection() });
const redis = new Redis(redisConnection());
const database = new Pool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'flashsale',
  password: process.env.POSTGRES_PASSWORD ?? 'flashsale_password',
  database: process.env.POSTGRES_DB ?? 'flashsale',
  max: 3,
  connectionTimeoutMillis: 3000,
});
const resultsDirectory = process.env.LOADTEST_RESULTS_DIR ?? '/app/loadtest-results';
const dashboardProductId = process.env.DASHBOARD_PRODUCT_ID ?? 'p-1001';

serverAdapter.setBasePath('/admin/queues');
createBullBoard({ queues: [new BullMQAdapter(queue)], serverAdapter });

async function readSummary(filename: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(resultsDirectory, filename), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

app.get('/', (_request, response) => response.redirect('/dashboard'));
app.get('/dashboard', (_request, response) => {
  response.sendFile(join(process.cwd(), 'public', 'dashboard.html'));
});

app.get('/api/dashboard', async (_request, response) => {
  try {
    const [cacheValues, queueCounts, workers, integrityResult, readTest, writeTest] = await Promise.all([
      redis.hmget('metrics:product-cache', 'hits', 'misses'),
      queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      queue.getWorkers(),
      database.query<{
        product_id: string;
        available_stock: number;
        remaining_stock: number;
        stock_is_zero: boolean;
        no_negative_stock: boolean;
        total_orders: number;
        unique_users: number;
        max_order_per_user: number;
        duplicate_users: number;
      }>(
        `WITH per_user AS (
           SELECT user_id, COUNT(*)::INTEGER AS order_count
           FROM orders
           WHERE product_id = $1
           GROUP BY user_id
         )
         SELECT
           p.product_id,
           p.available_stock,
           p.remaining_stock,
           p.remaining_stock = 0 AS stock_is_zero,
           NOT EXISTS (SELECT 1 FROM products WHERE remaining_stock < 0) AS no_negative_stock,
           COALESCE((SELECT SUM(order_count) FROM per_user), 0)::INTEGER AS total_orders,
           (SELECT COUNT(*) FROM per_user)::INTEGER AS unique_users,
           COALESCE((SELECT MAX(order_count) FROM per_user), 0)::INTEGER AS max_order_per_user,
           (SELECT COUNT(*) FROM per_user WHERE order_count > 1)::INTEGER AS duplicate_users
         FROM products AS p
         WHERE p.product_id = $1`,
        [dashboardProductId],
      ),
      readSummary('read-summary.json'),
      readSummary('write-summary.json'),
    ]);

    const hits = Number(cacheValues[0] ?? 0);
    const misses = Number(cacheValues[1] ?? 0);
    const cacheTotal = hits + misses;

    response.setHeader('Cache-Control', 'no-store');
    response.json({
      generatedAt: new Date().toISOString(),
      cache: {
        hits,
        misses,
        total: cacheTotal,
        hitRatio: cacheTotal ? hits / cacheTotal : 0,
        missRatio: cacheTotal ? misses / cacheTotal : 0,
      },
      queue: { ...queueCounts, workers: workers.length },
      loadTests: { read: readTest, write: writeTest },
      dataIntegrity: integrityResult.rows[0] ?? null,
    });
  } catch (error) {
    response.status(503).json({
      status: 'unavailable',
      message: error instanceof Error ? error.message : 'Dashboard data unavailable',
    });
  }
});

app.use('/admin/queues', serverAdapter.getRouter());
app.get('/health', (_request, response) => response.json({ status: 'ok' }));

const server = app.listen(Number(process.env.MONITOR_PORT ?? 3001), '0.0.0.0');

const shutdown = async () => {
  server.close();
  await Promise.all([queue.close(), redis.quit(), database.end()]);
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
