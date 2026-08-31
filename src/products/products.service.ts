import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { redisConnection } from '../config';
import { Product } from './product.entity';

@Injectable()
export class ProductsService implements OnModuleDestroy {
  private readonly redis = new Redis(redisConnection());
  private pendingCacheHits = 0;
  private pendingCacheMisses = 0;
  private metricFlushPromise: Promise<void> | null = null;
  private readonly metricFlushTimer: NodeJS.Timeout;
  private readonly getCachedPageScript = `
    local version = redis.call('GET', KEYS[1]) or '0'
    local cacheKey = 'products:v' .. version .. ':page:' .. ARGV[1] .. ':limit:' .. ARGV[2]
    local value = redis.call('GET', cacheKey)
    if value then
      return { value, cacheKey }
    end
    return { false, cacheKey }
  `;

  constructor(@InjectRepository(Product) private readonly repository: Repository<Product>) {
    this.metricFlushTimer = setInterval(() => {
      void this.queueMetricFlush();
    }, 250);
    this.metricFlushTimer.unref();
  }

  async list(page: number, limit: number) {
    if (page < 1 || limit < 1 || limit > 100) {
      throw new BadRequestException('page must be >= 1 and limit must be between 1 and 100');
    }
    const [cached, key] = await this.redis.eval(
      this.getCachedPageScript,
      1,
      'products:cache:version',
      page,
      limit,
    ) as [string | null, string];
    if (cached) {
      this.pendingCacheHits += 1;
      return cached;
    }

    this.pendingCacheMisses += 1;
    const [data, total] = await this.repository.findAndCount({
      select: ['productId', 'name', 'price', 'availableStock', 'remainingStock', 'isFlashSaleActive'],
      order: { productId: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const response = {
      status: 'success',
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
    const serialized = JSON.stringify(response);
    await this.redis.set(key, serialized, 'EX', 300);
    return serialized;
  }

  async cacheMetrics() {
    await this.queueMetricFlush();
    const values = await this.redis.hmget('metrics:product-cache', 'hits', 'misses');
    const hits = Number(values[0] ?? 0);
    const misses = Number(values[1] ?? 0);
    const total = hits + misses;
    return { status: 'success', hits, misses, hitRatio: total ? hits / total : 0 };
  }

  private queueMetricFlush() {
    if (!this.metricFlushPromise) {
      this.metricFlushPromise = this.flushCacheMetrics().finally(() => {
        this.metricFlushPromise = null;
      });
    }
    return this.metricFlushPromise;
  }

  private async flushCacheMetrics() {
    const hits = this.pendingCacheHits;
    const misses = this.pendingCacheMisses;
    this.pendingCacheHits = 0;
    this.pendingCacheMisses = 0;
    if (!hits && !misses) return;

    try {
      const pipeline = this.redis.pipeline();
      if (hits) pipeline.hincrby('metrics:product-cache', 'hits', hits);
      if (misses) pipeline.hincrby('metrics:product-cache', 'misses', misses);
      await pipeline.exec();
    } catch {
      this.pendingCacheHits += hits;
      this.pendingCacheMisses += misses;
    }
  }

  async onModuleDestroy() {
    clearInterval(this.metricFlushTimer);
    if (this.metricFlushPromise) await this.metricFlushPromise;
    await this.queueMetricFlush();
    await this.redis.quit();
  }
}
