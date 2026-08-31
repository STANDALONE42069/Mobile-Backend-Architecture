import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Order } from './orders/order.entity';
import { Product } from './products/product.entity';

export const redisConnection = () => ({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
  enableAutoPipelining: true,
});

export const databaseOptions = (poolMax = Number(process.env.API_DB_POOL_MAX ?? 10)): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? 'flashsale',
  password: process.env.POSTGRES_PASSWORD ?? 'flashsale_password',
  database: process.env.POSTGRES_DB ?? 'flashsale',
  entities: [Product, Order],
  synchronize: false,
  extra: {
    max: poolMax,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
  },
});

