import { Global, Module } from '@nestjs/common';
import { FunctionValidatorService } from './function-validator.service';
import { HttpFunctionRunner } from './http-function.runner';
import { ParamValidatorService } from './param-validator.service';
import { RegistryService } from './registry.service';
import { SqlFunctionRunner } from './sql-function.runner';

@Global()
@Module({
  providers: [
    RegistryService,
    ParamValidatorService,
    FunctionValidatorService,
    SqlFunctionRunner,
    HttpFunctionRunner,
  ],
  exports: [
    RegistryService,
    ParamValidatorService,
    FunctionValidatorService,
    SqlFunctionRunner,
    HttpFunctionRunner,
  ],
})
export class RegistryModule {}
