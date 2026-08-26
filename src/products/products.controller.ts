import { Controller, Get, ParseIntPipe, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 10,
  ) {
    return this.products.list(page, limit);
  }

  @Get('cache-metrics')
  metrics() {
    return this.products.cacheMetrics();
  }
}

