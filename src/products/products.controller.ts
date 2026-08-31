import { Controller, Get, ParseIntPipe, Query, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { ProductsService } from './products.service';

@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  async list(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 10,
    @Res() response: FastifyReply,
  ) {
    const body = await this.products.list(page, limit);
    response.type('application/json').send(body);
  }

  @Get('cache-metrics')
  metrics() {
    return this.products.cacheMetrics();
  }
}
