import { ConflictException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { redisConnection } from '../config';

export const ORDER_QUEUE = 'orders';

@Injectable()
export class OrdersService implements OnModuleDestroy {
  private readonly redis = new Redis(redisConnection());
  private readonly queue = new Queue(ORDER_QUEUE, { connection: redisConnection() });

  async enqueue(userId: string, productId: string) {
    const reservationKey = `reservation:${productId}:${userId}`;
    const ttl = Number(process.env.RESERVATION_TTL_SECONDS ?? 300);
    const reserved = await this.redis.set(reservationKey, '1', 'EX', ttl, 'NX');
    if (reserved !== 'OK') throw new ConflictException('User already submitted an order for this product');

    try {
      const job = await this.queue.add('purchase', { userId, productId, reservationKey }, {
        jobId: `${productId}__${userId}`,
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 86400, count: 10000 },
      });
      return {
        status: 'processing',
        orderJobId: String(job.id),
        message: 'Your order is in the queue.',
      };
    } catch (error) {
      await this.redis.del(reservationKey);
      throw error;
    }
  }

  async onModuleDestroy() {
    await Promise.all([this.queue.close(), this.redis.quit()]);
  }
}

