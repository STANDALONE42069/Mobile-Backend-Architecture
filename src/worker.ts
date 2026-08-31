import 'reflect-metadata';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { databaseOptions, redisConnection } from './config';
import { ORDER_QUEUE } from './orders/orders.service';

type OrderJob = { userId: string; productId: string; reservationKey: string };

const CLAIM_STOCK_SQL = `
  WITH claimed AS (
    UPDATE products
       SET remaining_stock = remaining_stock - 1
     WHERE product_id = $1 AND is_flash_sale_active = TRUE AND remaining_stock > 0
    RETURNING product_id
  )
  INSERT INTO orders (user_id, product_id, status)
  SELECT $2, product_id, 'CONFIRMED'::order_status FROM claimed
  RETURNING order_id
`;

const TERMINAL_FAILURES = new Set(['OUT_OF_STOCK_OR_INACTIVE', 'DUPLICATE_ORDER']);

const isUniqueViolation = (error: unknown) => {
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return candidate.code === '23505' || candidate.driverError?.code === '23505';
};

async function bootstrap() {
  const dataSource = new DataSource(databaseOptions(Number(process.env.WORKER_DB_POOL_MAX ?? 10)) as never);
  await dataSource.initialize();
  const redis = new Redis(redisConnection());

  const worker = new Worker<OrderJob>(ORDER_QUEUE, async (job: Job<OrderJob>) => {
    const { userId, productId } = job.data;
    let inserted: Array<{ order_id: string }>;
    try {
      // Single data-modifying CTE: the stock decrement and the order insert commit or roll back together.
      inserted = await dataSource.query(CLAIM_STOCK_SQL, [productId, userId]) as Array<{ order_id: string }>;
    } catch (error) {
      if (isUniqueViolation(error)) throw new UnrecoverableError('DUPLICATE_ORDER');
      throw error;
    }
    if (inserted.length === 0) throw new UnrecoverableError('OUT_OF_STOCK_OR_INACTIVE');

    await redis.incr('products:cache:version');
    return { status: 'CONFIRMED', orderId: inserted[0].order_id };
  }, {
    connection: redisConnection(),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
  });

  // Free the reservation slot only when a legitimate order was lost to a transient fault, so the
  // user is not locked out for the full TTL. Business-rule rejections keep the slot: releasing it
  // would let a client's duplicate burst win a second 202 instead of the required 409.
  worker.on('failed', (job, error) => {
    if (!job?.data.reservationKey) return;
    if (TERMINAL_FAILURES.has(error.message)) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    void redis.del(job.data.reservationKey);
  });

  worker.on('error', (error) => console.error(`Worker error: ${error.message}`));

  const shutdown = async () => {
    await worker.close();
    await redis.quit();
    await dataSource.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
