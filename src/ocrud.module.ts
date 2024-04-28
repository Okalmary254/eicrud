import { DynamicModule, Module, Type } from '@nestjs/common';
import { CrudController } from './crud/crud.controller';
import { CrudConfigService } from './crud/crud.config.service';
import { CrudAuthorizationService } from './crud/crud.authorization.service';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { NestApplication } from '@nestjs/core';
import { APP_GUARD } from '@nestjs/core';

@Module({})
export class OCRUDModule {
  static register(ConfigService: Type<CrudConfigService>,app: NestApplication): DynamicModule {
    
    return {
      module: OCRUDModule,
      providers: [CrudAuthorizationService, AuthService, ConfigService,
        {
          provide: APP_GUARD,
          useClass: AuthGuard,
        },
      ],
      controllers: [CrudController],
      exports: [],
      
    };
  }
}