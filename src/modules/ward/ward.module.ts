import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { WardController } from './ward.controller';
import { WardService } from './ward.service';
import { PrismaService } from '../prisma/prisma.service';
import { CheckIdMiddleware } from 'src/common/middleware/checkId.middleware';

@Module({
  controllers: [WardController],
  providers: [WardService],
})
export class WardModule implements NestModule {
  constructor(private prisma: PrismaService) {}

  configure(consumer: MiddlewareConsumer) {
    const model = this.prisma.ward;
    consumer.apply(new CheckIdMiddleware(model).use).forRoutes(
      {
        path: 'api/ward/detail',
        method: RequestMethod.GET,
      },
      {
        path: 'api/ward/update',
        method: RequestMethod.PUT,
      },
    );
  }
}
