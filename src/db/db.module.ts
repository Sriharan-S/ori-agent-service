import { Global, Module } from '@nestjs/common';
import { PrimaryDb } from './primary.db';
import { ReadDb } from './read.db';

@Global()
@Module({
  providers: [PrimaryDb, ReadDb],
  exports: [PrimaryDb, ReadDb],
})
export class DbModule {}
