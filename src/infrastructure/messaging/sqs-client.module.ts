import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from './sqs.constants.js';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SQSClient => {
        const endpoint = config.get<string>('SQS_ENDPOINT');
        const localCredentials = endpoint
          ? {
              accessKeyId: config.get<string>('AWS_ACCESS_KEY_ID', 'test'),
              secretAccessKey: config.get<string>('AWS_SECRET_ACCESS_KEY', 'test')
            }
          : undefined;

        return new SQSClient({
          region: config.get<string>('AWS_REGION', 'us-east-1'),
          ...(endpoint ? { endpoint, credentials: localCredentials } : {})
        });
      }
    }
  ],
  exports: [SQS_CLIENT]
})
export class SqsClientModule {}
