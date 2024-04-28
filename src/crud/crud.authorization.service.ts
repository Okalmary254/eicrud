import { ForbiddenException } from "@nestjs/common";
import { AuthUtils } from "../auth/auth.utils";
import { CrudContext } from "./model/CrudContext";
import { CrudRole } from "./model/CrudRole";
import { defineAbility, subject } from "@casl/ability";
import { BatchRights, CrudSecurity, httpAliasResolver } from "./model/CrudSecurity";
import { CrudUserService } from "../user/crud-user.service";
import { CrudConfigService } from "./crud.config.service";
import { CrudUser } from "../user/model/CrudUser";


export class CrudAuthorizationService {

    rolesMap: Record<string, CrudRole> = {};
    constructor(
        protected crudConfig: CrudConfigService
    ) { 
        this.rolesMap = crudConfig.roles.reduce((acc, role) => {
            acc[role.name] = role;
            return acc;
        }, {});
    }

    getCtxUserRole(ctx: CrudContext): CrudRole {
        const role = ctx.user?.role || this.crudConfig.guest_role;
        return this.rolesMap[role];
    }

    
    getUserRole(user: CrudUser): CrudRole {
        const role = user?.role || this.crudConfig.guest_role;
        return this.rolesMap[role];
    }

    getMatchBatchSizeFromCrudRoleAndParents(ctx: CrudContext, userRole: CrudRole){
        const roleRights = ctx.security.rolesRights[userRole.name];
        let batchRights: BatchRights;
        
        switch (ctx.method) {
            case 'POST':
                batchRights = roleRights.createBatchRights
            break;
            case 'PUT':
            case 'PATCH':
                batchRights = roleRights.updateBatchRights;
            break;
            case 'DELETE':
                batchRights = roleRights.deleteBatchRights;
            break;
        }

        let maxBatchSize = batchRights?.maxBatchSize || 0;

        if (userRole.inherits?.length) {
            for (const parent of userRole.inherits) {
                const parentRole = this.rolesMap[parent];
                const parentMaxBatchSize = this.getMatchBatchSizeFromCrudRoleAndParents(ctx, parentRole);
                if (parentMaxBatchSize > maxBatchSize) {
                    maxBatchSize = parentMaxBatchSize;
                }
            }
        }
        return maxBatchSize;

    }

    authorizeBatch(ctx: CrudContext, batchSize: number) {
        
        const userRole: CrudRole = this.getCtxUserRole(ctx);
        const adminBatch = this.getCtxUserRole(ctx).isAdminRole ? 100 : 0;

        const maxBatchSize = Math.max(adminBatch, this.getMatchBatchSizeFromCrudRoleAndParents(ctx, userRole));
        
        if (batchSize > maxBatchSize) {
            throw new ForbiddenException(`Maxbatchsize (${maxBatchSize}) exceeded (${batchSize}).`);
        }

    }

    async authorize(ctx: CrudContext) {

        const fields = AuthUtils.getObjectFields(ctx.data);

        if (ctx.origin == 'crud' && ctx.security.maxItemsPerUser && 
            this.crudConfig.userService.notGuest(ctx.user) &&
            ctx.method == 'POST') {
            const count = ctx.user?.crudUserDataMap?.[ctx.serviceName]?.itemsCreated;
            let max = ctx.security.maxItemsPerUser;
            let add = ctx?.security.additionalItemsInDbPerTrustPoints;
            if(add){
               add = add*(await this.crudConfig.userService.getOrComputeTrust(ctx.user, ctx));
               max+=Math.max(add,0);
            }
            if (count >= max) {
                throw new ForbiddenException(`You have reached the maximum number of items for this resource (${ctx.security.maxItemsPerUser})`);
            }
        }else if (ctx.origin == 'cmd'){
            const cmdSec = ctx.security.cmdSecurityMap?.[ctx.cmdName];
            if(cmdSec?.maxUsesPerUser && this.crudConfig.userService.notGuest(ctx.user)) {
                if(ctx.method != 'POST'){
                    // in that case user is cached and we can't check the cmd count properly
                    throw new ForbiddenException(`Command must be used in secure mode (POST)`);
                }
                let max = cmdSec.maxUsesPerUser;
                let add = cmdSec.additionalUsesPerTrustPoint;
                if(add){
                   add = add*(await this.crudConfig.userService.getOrComputeTrust(ctx.user, ctx));
                   max+=Math.max(add,0);
                }
                const count = ctx.user?.crudUserDataMap?.[ctx.serviceName]?.cmdMap?.[ctx.cmdName];
                if (count >= max) {
                    throw new ForbiddenException(`You have reached the maximum uses for this command (${ctx.security.maxItemsPerUser})`);
                }
            }
        }
  

        const crudRole: CrudRole = this.getCtxUserRole(ctx);

        const checkRes = this.recursCheckRolesAndParents(crudRole, ctx, fields);

        if (!checkRes) {
            let msg = `Role ${ctx.user.role} is not allowed to ${ctx.method} ${ctx.serviceName} ${ctx.cmdName}`;
            throw new ForbiddenException(msg);
        }

        return true;
    }

    loopFieldAndCheckCannot(allGood, method, query, fields, userAbilities, crudContext: CrudContext){
        for (const field of fields) {
            const sub = subject(crudContext.serviceName, query);
            if (userAbilities.cannot(method, sub, field)) {
                allGood = false;
                break;
            }
        }
        return allGood;
    }

    recursCheckRolesAndParents(role: CrudRole, crudContext: CrudContext, fields: string[]): CrudRole | null {
        const roleRights = crudContext.security.rolesRights[role.name];
        const userAbilities = defineAbility((can, cannot) => {
            
            if(crudContext.origin == "crud"){
                roleRights.defineCRUDAbility(can, cannot, crudContext);
            }else{
                roleRights.defineCMDAbility(can, cannot, crudContext);
            }
            
            if (roleRights.fields && crudContext.method == 'GET') {
                crudContext.options.fields = roleRights.fields as any;
            }
        }, { resolveAction: httpAliasResolver });
        const methodToCheck = crudContext.origin == "crud" ? crudContext.method : crudContext.cmdName;
        let allGood = this.loopFieldAndCheckCannot(true, methodToCheck, crudContext.query, fields, userAbilities, crudContext);
        
        if (allGood && crudContext.options) {
            const userOptionsAbilities = defineAbility((can, cannot) => {
                roleRights.defineOPTAbility(can, cannot, crudContext);
            }, {});
            for(const key of Object.keys(crudContext.options)){
                allGood = this.loopFieldAndCheckCannot(true, key, crudContext.options, fields, userOptionsAbilities, crudContext);
                if(!allGood){
                    break;
                }
            }
        }

        if (allGood) {
            return role;
        }
        if (role.inherits?.length) {
            for (const parent of role.inherits) {
                const parentRole = this.rolesMap[parent];
                const checkRes = this.recursCheckRolesAndParents(parentRole, crudContext, fields)
                if (checkRes) {
                    return checkRes;
                }
            }
        }
        return null;
    }
}
