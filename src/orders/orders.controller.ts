import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OrdersService } from './orders.service';

class CreateOrderRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  productId!: string;
}

@Controller('api/v1/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(202)
  @UseGuards(JwtAuthGuard)
  create(@Req() request: AuthenticatedRequest, @Body() body: CreateOrderRequest) {
    return this.orders.enqueue(request.user.userId, body.productId);
  }
}

