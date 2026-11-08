import { Module } from '@nestjs/common';
import { WageringController } from './wagering.controller.js';
import { WageringService } from './wagering.service.js';

@Module({
  controllers: [WageringController],
  providers: [WageringService],
  exports: [WageringService]
})
export class WageringModule {}
