import 'dotenv/config';
import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering_dev@localhost:5432/wagering',
  entities: ['./dist/**/*.entity.js'],
  entitiesTs: ['./src/**/*.entity.ts'],
  metadataProvider: ReflectMetadataProvider,
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    path: './dist/infrastructure/persistence/migrations',
    pathTs: './src/infrastructure/persistence/migrations',
    transactional: true,
    allOrNothing: true,
    snapshot: false
  },
  debug: process.env.NODE_ENV === 'development'
});
