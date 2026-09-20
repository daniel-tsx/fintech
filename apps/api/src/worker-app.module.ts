import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { JobsModule } from './jobs/jobs.module';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), LoggerModule.forRoot(), DatabaseModule, CommonModule, JobsModule] })
export class WorkerAppModule {}
