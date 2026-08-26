import { BadRequestException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { redisConnection } from '../config';
import { Product } from './product.entity';

@Injectable()
export class ProductsService implements OnModuleDestroy {
  private readonly redis = new Redis(redisConnection());

  constructor(@InjectRepository(Product) private readonly repository: Repository<Product>) {}

  async list(page: number, limit: number) {
    if (page < 1 || limit < 1 || limit > 100) {
      throw new BadRequestException('page must be >= 1 and limit must be between 1 and 100');
    }
    const version = (await this.redis.get('products:cache:version')) ?? '1';
    const key = `products:v${version}:page:${page}:limit:${limit}`;
    const cached = await this.redis.get(key);
    if (cached) {
      await this.redis.hincrby('metrics:product-cache', 'hits', 1);
      return JSON.parse(cached) as unknown;
    }

    await this.redis.hincrby('metrics:product-cache', 'misses', 1);
    const [data, total] = await this.repository.findAndCount({
      order: { productId: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const response = {
      status: 'success',
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
    await this.redis.set(key, JSON.stringify(response), 'EX', 60);
    return response;
  }

  async cacheMetrics() {
    const values = await this.redis.hmget('metrics:product-cache', 'hits', 'misses');
    const hits = Number(values[0] ?? 0);
    const misses = Number(values[1] ?? 0);
    const total = hits + misses;
    return { status: 'success', hits, misses, hitRatio: total ? hits / total : 0 };
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }
}

