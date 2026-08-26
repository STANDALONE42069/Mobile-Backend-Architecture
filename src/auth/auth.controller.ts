import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

class TokenRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  userId!: string;
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly jwt: JwtService) {}

  @Post('token')
  @HttpCode(200)
  async token(@Body() body: TokenRequest) {
    return {
      status: 'success',
      accessToken: await this.jwt.signAsync({ sub: body.userId, userId: body.userId }),
    };
  }
}
