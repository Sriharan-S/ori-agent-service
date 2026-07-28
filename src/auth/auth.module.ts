import { Global, Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard, ManagementKeyGuard } from './api-key.guard';
import { EndUserResolverService } from './end-user-resolver.service';
import { RateLimitGuard } from './rate-limit.guard';
import { RoleService } from './role.service';

@Global()
@Module({
  providers: [
    ApiKeyService,
    EndUserResolverService,
    RoleService,
    ApiKeyGuard,
    ManagementKeyGuard,
    RateLimitGuard,
  ],
  exports: [
    ApiKeyService,
    EndUserResolverService,
    RoleService,
    ApiKeyGuard,
    ManagementKeyGuard,
    RateLimitGuard,
  ],
})
export class AuthModule {}
