import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { CrudService } from './crud.service';
import { CrudContext } from './model/CrudContext';
import { Context } from '../authentication/auth.utils';
import { MsLinkQuery, CrudQuery } from '../crud/model/CrudQuery';
import { CrudAuthorizationService } from './crud.authorization.service';
import { setImmediate } from 'timers/promises';
import replyFrom from '@fastify/reply-from';
import fastifyCookie from '@fastify/cookie';
import {
  CRUD_CONFIG_KEY,
  CrudConfigService,
  MicroServicesOptions,
} from '../config/crud.config.service';
import { CmdSecurity } from '../config/model/CrudSecurity';
import { CrudErrors } from '@eicrud/shared/CrudErrors';
import { CrudAuthService } from '../authentication/auth.service';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import { _utils } from '../utils';
import { CrudTransformer, IFieldMetadata } from '../validation/CrudTransformer';
import { CrudValidationPipe } from '../validation/CrudValidationPipe';
import {
  DeleteResponseDto,
  FindResponseDto,
  LoginResponseDto,
} from '@eicrud/shared/interfaces';
import { getParentRoles } from '@eicrud/shared/utils';

export class LimitOptions {
  nonAdminQueryLimit = 40;
  adminQueryLimit = 400;

  nonAdminQueryLimit_IDS = 4000;
  adminQueryLimit_IDS = 8000;

  maxFindInIdsLength = 250;
}

@Controller({
  path: 'crud',
  version: '1',
})
export class CrudController {
  public crudConfig: CrudConfigService;
  constructor(
    private crudAuthService: CrudAuthService,
    public crudAuthorization: CrudAuthorizationService,
    private adapterHost: HttpAdapterHost,
    protected moduleRef: ModuleRef,
  ) {}

  async onModuleInit() {
    this.crudConfig = this.moduleRef.get(CRUD_CONFIG_KEY, { strict: false });
    const app = this.adapterHost.httpAdapter.getInstance();
    app.register(fastifyCookie, {
      secret:
        this.crudConfig.COOKIE_SECRET ||
        (await _utils.generateRandomString(16)),
    });
    this._initProxyController(app);
  }

  _initProxyController(app) {
    const msOptions: MicroServicesOptions =
      this.crudConfig.microServicesOptions;

    const currentMs = MicroServicesOptions.getCurrentService();

    if (!currentMs) {
      return;
    }

    let currentMsConfig = msOptions.microServices?.[currentMs];

    if (!currentMsConfig) {
      return;
    }

    if (!currentMsConfig.proxyCrudController) {
      return;
    }

    app.register(replyFrom);

    if (currentMsConfig.proxyCrudController) {
      const registered = {};
      for (const micro in msOptions.microServices) {
        if (micro == currentMs) {
          continue;
        }
        const other = msOptions.microServices[micro];
        if (!other.openController) {
          continue;
        }
        for (const serv of other.services) {
          if (currentMsConfig.services.includes(serv)) {
            continue;
          }
          const name = CrudService.getName(serv);
          if (registered[name]) {
            continue;
          }
          registered[name] = other.url;
        }
      }

      app.addHook('preValidation', async (request, reply) => {
        if (request.url.includes('/crud/s')) {
          const serviceName = request.url.split('/crud/s/')[1].split('/')[0];
          const url = registered[serviceName];
          if (url) {
            const rest = request.url;
            request.headers['x-forwarded-for'] = request.ip;
            return await reply.from(url + rest);
          }
        }
      });
    }
  }

  assignContext(
    method: 'POST' | 'GET' | 'PATCH' | 'DELETE',
    crudQuery: CrudQuery,
    query: any,
    data: any,
    type,
    ctx: CrudContext,
  ): CrudService<any> {
    const currentService: CrudService<any> =
      this.crudConfig.servicesMap[crudQuery?.service];
    this.checkServiceNotFound(currentService, crudQuery);
    ctx.method = method;
    ctx.serviceName = crudQuery.service;
    ctx.query = query;
    ctx.data = data;
    ctx.options = crudQuery.options;
    ctx.origin = type;

    ctx._temp = ctx._temp || {};
    ctx.store = ctx.store || {};

    ctx.getCurrentService = () => currentService;

    if (ctx.origin == 'cmd') {
      ctx.cmdName = crudQuery.cmd;
    }
    return currentService;
  }

  async beforeHooks(service: CrudService<any>, ctx: CrudContext) {
    //await service.beforeControllerHook(ctx);
    await this.crudConfig.beforeControllerHook(ctx);
    if (ctx.origin == 'cmd') {
      const cmdSecurity: CmdSecurity =
        service.security?.cmdSecurityMap?.[ctx.cmdName];
      if (cmdSecurity?.hooks) {
        ctx.data = await cmdSecurity.hooks?.beforeControllerHook(ctx.data, ctx);
      }
    }
  }

  async afterHooks(service: CrudService<any>, res, ctx: CrudContext) {
    if (ctx.origin == 'cmd') {
      const cmdSecurity: CmdSecurity =
        service.security?.cmdSecurityMap?.[ctx.cmdName];
      if (cmdSecurity?.hooks) {
        res = await cmdSecurity.hooks?.afterControllerHook(ctx.data, res, ctx);
      }
    }
    res = await this.crudConfig.afterControllerHook(res, ctx);
    if (ctx.setCookies) {
      const fastifyReply = ctx.getHttpResponse();
      for (const key in ctx.setCookies) {
        const cookie = ctx.setCookies[key];
        fastifyReply.setCookie(key, cookie.value, cookie);
      }
    }
    return res;
  }
  async errorHooks(
    service: CrudService<any>,
    e: Error | any,
    ctx: CrudContext,
  ) {
    //await service.errorControllerHook(e, ctx);
    let res: any;
    if (ctx.origin == 'cmd') {
      const cmdSecurity: CmdSecurity =
        service.security?.cmdSecurityMap?.[ctx.cmdName];
      if (cmdSecurity?.hooks) {
        res = await cmdSecurity.hooks?.errorControllerHook(ctx.data, e, ctx);
      }
    }
    res = (await this.crudConfig.errorControllerHook(e, ctx)) || res;
    res = (await service.errorControllerHook(e, ctx)) || res;
    const notGuest = this.crudConfig.userService.notGuest(ctx?.user);
    if (notGuest) {
      let patch;
      if (e instanceof ForbiddenException || e.status == HttpStatus.FORBIDDEN) {
        patch = { incidentCount: ctx.user.incidentCount + 1 };
        const inc = { incidentCount: 1 };
        this.crudConfig.userService.$unsecure_incPatch(
          {
            query: {
              [this.crudConfig.id_field]: ctx.user[this.crudConfig.id_field],
            },
            increments: inc,
          },
          ctx,
        );
      } else {
        patch = { errorCount: ctx.user.errorCount + 1 };
        const inc = { errorCount: 1 };
        this.crudConfig.userService.$unsecure_incPatch(
          {
            query: {
              [this.crudConfig.id_field]: ctx.user[this.crudConfig.id_field],
            },
            increments: inc,
          },
          ctx,
        );
      }
      ctx.user = {
        ...ctx.user,
        ...patch,
      };
      this.crudConfig.userService.$setCached(ctx.user, ctx);
    }
    if (res) {
      return res;
    }
    throw e;
  }

  checkServiceNotFound(currentService, crudQuery: CrudQuery) {
    if (!currentService) {
      throw new BadRequestException('Service not found: ' + crudQuery.service);
    }
  }

  @Post('s/:service/one')
  async _create(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Body() newEntity: any,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'POST',
      query,
      newEntity,
      newEntity,
      'crud',
      ctx,
    );
    try {
      await this.performValidationAuthorizationAndHooks(ctx, currentService);

      let res = await currentService.$create_(ctx);

      res = await this.afterHooks(currentService, res, ctx);

      this.addCountToDataMap(ctx, 1);

      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Post('s/:service/batch')
  async _batchCreate(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Body() newEntities: any[],
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'POST',
      query,
      null,
      newEntities,
      'crud',
      ctx,
    );
    ctx.isBatch = true;
    try {
      await this.crudAuthorization.authorizeBatch(
        ctx,
        newEntities,
        currentService.security,
      );

      for (let i = 0; i < newEntities.length; i++) {
        await this.assignContext(
          'POST',
          query,
          newEntities[i],
          newEntities[i],
          'crud',
          ctx,
        );
        await this.performValidationAuthorizationAndHooks(
          ctx,
          currentService,
          true,
        );
        if (
          i % this.crudConfig.validationOptions.batchValidationYieldRate ===
          0
        ) {
          await setImmediate(); // allow other requests to be processed
        }
      }

      await this.assignContext('POST', query, null, newEntities, 'crud', ctx);
      await this.beforeHooks(currentService, ctx);
      let results = await currentService.$createBatch_(ctx);
      results = await this.afterHooks(currentService, results, ctx);
      this.addCountToDataMap(ctx, newEntities.length);
      this.crudConfig.userService.$setCached(ctx.user, ctx);

      return results;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Post('s/:service/cmd/:cmd')
  async _secureCMD(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Param('cmd') cmd: string,
    @Body() data,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    query.cmd = cmd;
    return this.subCMD(query, data, ctx, 'POST');
  }

  @Patch('s/:service/cmd/:cmd')
  async _unsecureCMD(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Param('cmd') cmd: string,
    @Body() data,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    query.cmd = cmd;
    return this.subCMD(query, data, ctx, 'PATCH');
  }

  @Get('s/:service/cmd/:cmd')
  async _readCMD(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Param('cmd') cmd: string,
    @Body() data,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    query.cmd = cmd;
    return this.subCMD(query, query.query, ctx, 'GET');
  }

  async subCMD(
    query: CrudQuery,
    data,
    ctx: CrudContext,
    METHOD: 'POST' | 'GET' | 'PATCH' | 'DELETE',
  ) {
    const currentService = await this.assignContext(
      METHOD,
      query,
      data,
      data,
      'cmd',
      ctx,
    );
    try {
      const cmdSecurity: CmdSecurity =
        currentService.security?.cmdSecurityMap?.[ctx.cmdName];
      if (!cmdSecurity) {
        throw new ForbiddenException(
          `Command ${ctx.cmdName} not found in security map`,
        );
      }
      if (ctx.method == 'GET' && !cmdSecurity.allowGetMethod) {
        throw new ForbiddenException(CrudErrors.GET_METHOD_NOT_ALLOWED.str());
      }
      if (cmdSecurity.batchField && data?.[cmdSecurity.batchField]) {
        await this.crudAuthorization.authorizeBatch(
          ctx,
          data[cmdSecurity.batchField],
          cmdSecurity,
        );
      }
      this.limitQuery(
        ctx,
        cmdSecurity?.nonAdminQueryLimit ||
          this.crudConfig.limitOptions.nonAdminQueryLimit,
        cmdSecurity?.adminQueryLimit ||
          this.crudConfig.limitOptions.adminQueryLimit,
      );
      await this.performValidationAuthorizationAndHooks(ctx, currentService);
      let res = await currentService.$cmdHandler(query.cmd, ctx);
      this.addCountToCmdMap(ctx, 1, !!cmdSecurity.minTimeBetweenCmdCallMs);
      res = await this.afterHooks(currentService, res, ctx);
      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Get('s/:service/many')
  async _find(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'GET',
      query,
      query.query,
      null,
      'crud',
      ctx,
    );
    try {
      return await this.subFind(
        query,
        ctx,
        this.crudConfig.limitOptions.nonAdminQueryLimit,
        this.crudConfig.limitOptions.adminQueryLimit,
        currentService,
      );
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Get('s/:service/ids')
  async _findIds(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Context() ctx: CrudContext,
  ) {
    query.options = query.options || {};
    query.options.fields = [this.crudConfig.id_field as any];
    query.service = service;
    const currentService = await this.assignContext(
      'GET',
      query,
      query.query,
      null,
      'crud',
      ctx,
    );
    try {
      const res: FindResponseDto<any> = await this.subFind(
        query,
        ctx,
        this.crudConfig.limitOptions.nonAdminQueryLimit_IDS,
        this.crudConfig.limitOptions.adminQueryLimit_IDS,
        currentService,
      );
      res.data = res.data.map((d) => d[this.crudConfig.id_field]);
      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  async subFind(
    query: CrudQuery,
    ctx: CrudContext,
    nonAdminQueryLimit,
    adminQueryLimit,
    currentService: CrudService<any> = undefined,
  ) {
    this.limitQuery(ctx, nonAdminQueryLimit, adminQueryLimit);
    await this.performValidationAuthorizationAndHooks(ctx, currentService);
    let res = await currentService.$find_(ctx);
    res = await this.afterHooks(currentService, res, ctx);
    return res;
  }

  @Get('s/:service/in')
  async _findIn(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'GET',
      query,
      query.query,
      null,
      'crud',
      ctx,
    );
    try {
      this.limitQuery(
        ctx,
        this.crudConfig.limitOptions.nonAdminQueryLimit,
        this.crudConfig.limitOptions.adminQueryLimit,
      );
      const ids = ctx.query?.[this.crudConfig.id_field];
      if (
        !ids ||
        !ids.length ||
        ids.length > this.crudConfig.limitOptions.maxFindInIdsLength
      ) {
        throw new BadRequestException(
          CrudErrors.IN_REQUIRED_LENGTH.str({
            maxBatchSize: this.crudConfig.limitOptions.maxFindInIdsLength,
            idsLength: ids.length,
          }),
        );
      }
      ctx.ids = ids;
      delete ctx.query[this.crudConfig.id_field];
      await this.performValidationAuthorizationAndHooks(ctx, currentService);
      let res = await currentService.$findIn_(ctx);
      res = await this.afterHooks(currentService, res, ctx);
      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Get('s/:service/one')
  async _findOne(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'GET',
      query,
      query.query,
      null,
      'crud',
      ctx,
    );
    try {
      await this.performValidationAuthorizationAndHooks(ctx, currentService);
      let res;
      if (ctx.options?.cached) {
        res = await currentService.$findOneCached_(ctx);
      } else {
        res = await currentService.$findOne_(ctx);
      }
      res = await this.afterHooks(currentService, res, ctx);
      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Delete('s/:service/one')
  async _delete(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'DELETE',
      query,
      query.query,
      null,
      'crud',
      ctx,
    );
    try {
      await this.performValidationAuthorizationAndHooks(ctx, currentService);
      let result = await currentService.$deleteOne_(ctx);
      result = await this.afterHooks(currentService, result, ctx); //PROBLEM?
      this.addCountToDataMap(ctx, -1);
      return result;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Delete('s/:service/many')
  async _deleteMany(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'DELETE',
      query,
      query.query,
      null,
      'crud',
      ctx,
    );
    try {
      await this.performValidationAuthorizationAndHooks(ctx, currentService);
      let res: DeleteResponseDto = await currentService.$delete_(ctx);
      res = await this.afterHooks(currentService, res, ctx);
      if (res?.count) {
        this.addCountToDataMap(ctx, -res.count);
      }
      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Delete('s/:service/in')
  async _deleteIn(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'DELETE',
      query,
      query.query,
      null,
      'crud',
      ctx,
    );
    try {
      const ids = ctx.query?.[this.crudConfig.id_field];
      if (
        !ids ||
        !ids.length ||
        ids.length > this.crudConfig.limitOptions.maxFindInIdsLength
      ) {
        throw new BadRequestException(
          CrudErrors.IN_REQUIRED_LENGTH.str({
            maxBatchSize: this.crudConfig.limitOptions.maxFindInIdsLength,
            idsLength: ids.length,
          }),
        );
      }
      ctx.ids = ids;
      delete ctx.query[this.crudConfig.id_field];
      await this.performValidationAuthorizationAndHooks(ctx, currentService);
      let res: DeleteResponseDto = await currentService.$deleteIn_(ctx);
      res = await this.afterHooks(currentService, res, ctx);
      if (res?.count) {
        this.addCountToDataMap(ctx, -res.count);
      }
      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Patch('s/:service/one')
  async _patchOne(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Body() data,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'PATCH',
      query,
      query.query,
      data,
      'crud',
      ctx,
    );
    if (!query.query || !data) {
      throw new BadRequestException(
        'Query and data are required for PATCH one.',
      );
    }
    try {
      await this.performValidationAuthorizationAndHooks(ctx, currentService);
      let res = await currentService.$patchOne_(ctx);
      res = await this.afterHooks(currentService, res, ctx);
      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Patch('s/:service/in')
  async _patchIn(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Body() data,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'PATCH',
      query,
      query.query,
      data,
      'crud',
      ctx,
    );
    try {
      const ids = ctx.query?.[this.crudConfig.id_field];
      if (
        !ids ||
        !ids.length ||
        ids.length > this.crudConfig.limitOptions.maxFindInIdsLength
      ) {
        throw new BadRequestException(
          CrudErrors.IN_REQUIRED_LENGTH.str({
            maxBatchSize: this.crudConfig.limitOptions.maxFindInIdsLength,
            idsLength: ids.length,
          }),
        );
      }
      ctx.ids = ids;
      delete ctx.query[this.crudConfig.id_field];
      await this.performValidationAuthorizationAndHooks(ctx, currentService);
      let res = await currentService.$patchIn_(ctx);
      res = await this.afterHooks(currentService, res, ctx);
      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Patch('s/:service/many')
  async _patchMany(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Body() data,
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'PATCH',
      query,
      query.query,
      data,
      'crud',
      ctx,
    );
    try {
      await this.performValidationAuthorizationAndHooks(ctx, currentService);
      let res = await currentService.$patch_(ctx);
      res = await this.afterHooks(currentService, res, ctx);
      return res;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  @Patch('s/:service/batch')
  async _batchPatch(
    @Query(new CrudValidationPipe()) query: CrudQuery,
    @Param('service') service: string,
    @Body() data: any[],
    @Context() ctx: CrudContext,
  ) {
    query.service = service;
    const currentService = await this.assignContext(
      'PATCH',
      query,
      null,
      null,
      'crud',
      ctx,
    );
    ctx.isBatch = true;
    try {
      await this.crudAuthorization.authorizeBatch(
        ctx,
        data,
        currentService.security,
      );

      for (let i = 0; i < data.length; i++) {
        await this.assignContext(
          'PATCH',
          query,
          data[i].query,
          data[i].data,
          'crud',
          ctx,
        );
        await this.performValidationAuthorizationAndHooks(
          ctx,
          currentService,
          true,
        );
        if (
          i % this.crudConfig.validationOptions.batchValidationYieldRate ===
          0
        ) {
          await setImmediate(); // allow other requests to be processed
        }
      }

      await this.assignContext('PATCH', query, null, data, 'crud', ctx);
      await this.beforeHooks(currentService, ctx);
      let results = await currentService.$patchBatch_(ctx);
      results = await this.afterHooks(currentService, results, ctx);

      return results;
    } catch (e) {
      return this.errorHooks(currentService, e, ctx);
    }
  }

  async performValidationAuthorizationAndHooks(
    ctx: CrudContext,
    currentService: CrudService<any>,
    skipBeforeHooks = false,
  ) {
    await this.validate(ctx, currentService);
    await this.crudAuthorization.authorize(ctx, currentService.security);
    if (!skipBeforeHooks) {
      await this.beforeHooks(currentService, ctx);
    }
  }

  async validate(ctx: CrudContext, currentService: CrudService<any>) {
    let queryClass = null;
    let dataClass = null;
    let dataDefaultValues = false;
    if (ctx.origin == 'crud') {
      if (ctx.method == 'POST') {
        dataClass = currentService.entity;
        dataDefaultValues = true;
      } else if (ctx.method == 'PATCH') {
        dataClass = currentService.entity;
        queryClass = currentService.entity;
      } else if (ctx.method == 'GET' || ctx.method == 'DELETE') {
        queryClass = currentService.entity;
      }

      const security = currentService.security;
      if (queryClass && security?.skipQueryValidationForRoles?.length) {
        const inheritedRoles = getParentRoles(
          ctx.user?.role,
          this.crudConfig.rolesMap,
        );
        if (
          security.skipQueryValidationForRoles.some((r) =>
            inheritedRoles.includes(r),
          )
        ) {
          queryClass = null;
        }
      }
    } else if (ctx.origin == 'cmd') {
      const cmdSecurity: CmdSecurity =
        currentService.security?.cmdSecurityMap?.[ctx.cmdName];
      if (!cmdSecurity?.dto) {
        throw new Error('dto missing for cmd: ' + ctx.cmdName);
      }
      if (ctx.method == 'GET') {
        queryClass = cmdSecurity.dto;
        dataClass = null;
      } else {
        dataDefaultValues = true;
        dataClass = cmdSecurity.dto;
        queryClass = null;
      }
    }
    const crudTransformer = new CrudTransformer(this, ctx);
    if (queryClass) {
      await crudTransformer.transform(ctx.query, queryClass);
      const newObj = { ...ctx.query };
      await crudTransformer.transformTypes(newObj, queryClass);
      Object.setPrototypeOf(newObj, queryClass.prototype);
      await crudTransformer.validateOrReject(newObj, true, 'Query:');
    }
    if (dataClass) {
      await crudTransformer.transform(ctx.data, dataClass);
      const newObj = { ...ctx.data };
      await crudTransformer.transformTypes(newObj, dataClass);
      Object.setPrototypeOf(newObj, dataClass.prototype);
      await crudTransformer.validateOrReject(
        newObj,
        !dataDefaultValues,
        'Data:',
      );
    }
  }

  addCountToCmdMap(ctx: CrudContext, ct: number, timestamp = false) {
    if (this.crudConfig.userService.notGuest(ctx?.user)) {
      const increments = {
        ['cmdUserCountMap.' + ctx.serviceName + '_' + ctx.cmdName]: ct,
      };
      const query = {
        [this.crudConfig.id_field]: ctx.user[this.crudConfig.id_field],
      };
      let addPatch = {};
      if (timestamp) {
        addPatch = {
          ['cmdUserLastUseMap.' + ctx.serviceName + '_' + ctx.cmdName]:
            new Date().getTime(),
        };
      }
      this.crudConfig.userService.$unsecure_incPatch(
        { query, increments, addPatch },
        ctx,
      );
    }
  }

  addCountToDataMap(ctx: CrudContext, ct: number) {
    //throw if ct is nan
    if (isNaN(ct)) {
      throw new BadRequestException('addCountToDataMap expects a number');
    }
    if (this.crudConfig.userService.notGuest(ctx?.user)) {
      const increments = { ['crudUserCountMap.' + ctx.serviceName]: ct };
      const query = {
        [this.crudConfig.id_field]: ctx.user[this.crudConfig.id_field],
      };
      this.crudConfig.userService.$unsecure_incPatch(
        { query, increments },
        ctx,
      );
    }
  }

  limitQuery(ctx: CrudContext, nonAdmin, admin) {
    const isAdmin = this.crudAuthorization.getCtxUserRole(ctx)?.isAdminRole;
    const MAX_LIMIT_FIND = isAdmin ? admin : nonAdmin;
    if (!ctx.options?.limit || ctx.options?.limit > MAX_LIMIT_FIND) {
      ctx.options = ctx.options || {};
      ctx.options.limit = MAX_LIMIT_FIND;
    }
  }

  @Patch('ms-link/:service')
  async msLink(
    @Query(new CrudValidationPipe({ skipValidation: true }))
    query: MsLinkQuery,
    @Param('service') service,
    @Body() data,
    @Context() msLinkCtx: CrudContext,
  ) {
    if (!msLinkCtx.msLinkGuarded) {
      throw new UnauthorizedException(
        'MsLink not guarded : (something is wrong with your auth guard.)',
      );
    }
    query.service = service;
    for (const i of query.undefinedArgs || []) {
      data.args[i] = undefined;
    }
    const ctx: CrudContext = query.ctxPos ? data.args[query.ctxPos] || {} : {};
    // const inheritance = query.inheritancePos
    //   ? data.args[query.inheritancePos]
    //   : null;
    ctx.currentMs = MicroServicesOptions.getCurrentService();
    try {
      const currentService = this.crudConfig.servicesMap[query.service];
      if (!currentService[query.methodName]) {
        throw new BadRequestException(
          'MsLink method not found: ' + query.methodName,
        );
      }
      await this.crudConfig.beforeMsLinkHook(ctx, query, data.args);
      const res = await currentService[query.methodName](...data.args);
      await this.crudConfig.afterMsLinkHook(res, ctx, query, data.args);

      const returnCtxFields = ['setCookies'];
      const response: any = { res };
      for (const field of returnCtxFields) {
        if (ctx[field]) {
          response.ctx = response.ctx || {};
          response.ctx[field] = ctx[field];
        }
      }
      return response;
    } catch (e) {
      await this.crudConfig.errorMsLinkHook(e, ctx, query, data.args);
      throw e;
    }
  }

  @Get('rdy')
  async ready() {
    return true;
  }
}
