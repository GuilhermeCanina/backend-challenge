import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from '../mikro-orm.config.js';
import { SqsClientModule } from './infrastructure/messaging/sqs-client.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { WageringModule } from './modules/wagering/wagering.module.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    MikroOrmModule.forRoot(mikroOrmConfig),
    SqsClientModule,
    HealthModule,
    WageringModule,
    MessagingModule
  ]
})
export class AppModule {}
