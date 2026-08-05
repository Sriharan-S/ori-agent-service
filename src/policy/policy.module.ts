import { Global, Module } from '@nestjs/common';
import { ResponsePolicyService } from './response-policy.service';

@Global()
@Module({
  providers: [ResponsePolicyService],
  exports: [ResponsePolicyService],
})
export class PolicyModule {}
