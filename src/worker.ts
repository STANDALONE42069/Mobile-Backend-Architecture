import 'reflect-metadata';
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { databaseOptions, redisConnection } from './config';
import { Order, OrderStatus } from './orders/order.entity';
import { ORDER_QUEUE } from './orders/orders.service';

type OrderJob = { userId: string; productId: string; reservationKey: string };

async function bootstrap() {
  const dataSource = new DataSource(databaseOptions(Number(process.env.WORKER_DB_POOL_MAX ?? 10)) as never);
  await dataSource.initialize();
  const redis = new Redis(redisConnection());

  const worker = new Worker<OrderJob>(ORDER_QUEUE, async (job: Job<OrderJob>) => {
    const { userId, productId } = job.data;
    await dataSource.transaction(async (manager) => {
      const existing = await manager.getRepository(Order).findOneBy({ userId, productId });
      if (existing) throw new Error('DUPLICATE_ORDER');

      const result = await manager.query(
        `UPDATE products
         SET remaining_stock = remaining_stock - 1
         WHERE product_id = $1 AND is_flash_sale_active = TRUE AND remaining_stock > 0
         RETURNING remaining_stock`,
        [productId],
      ) as [Array<{ remaining_stock: number }>, number];
      const [updatedProducts] = result;
      if (updatedProducts.length === 0) throw new Error('OUT_OF_STOCK_OR_INACTIVE');

      await manager.getRepository(Order).insert({ userId, productId, status: OrderStatus.CONFIRMED });
    });
    await redis.incr('products:cache:version');
    return { status: 'CONFIRMED' };
  }, {
    connection: redisConnection(),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
  });

  worker.on('completed', (job) => console.log(`Job ${job.id} completed`));
  worker.on('failed', (job, error) => console.error(`Job ${job?.id} failed: ${error.message}`));

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
