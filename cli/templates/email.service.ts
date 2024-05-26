import { Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { CrudService } from "../../core/crud/crud.service";
import Email from "./email.entity";
import { getSecurity } from "./email.security";

@Injectable()
export class EmailService extends CrudService<Email> implements EmailService {
    constructor(
        protected moduleRef: ModuleRef
    ) {
        const serviceName = CrudService.getName(Email);
        super(moduleRef, Email, getSecurity(serviceName));
    }

    sendVerificationEmail(to: string, token: string): Promise<any> {
        console.log('Sending verification email to', to, 'with token', token);
        return Promise.resolve();
    }

    sendTwoFactorEmail(to: string, code: string): Promise<any> {
        console.log('Sending two factor email to', to, 'with code', code);
        return Promise.resolve();
    }
    
    sendPasswordResetEmail(to: string, token: string): Promise<any> {
        console.log('Sending password reset email to', to, 'with token', token);
        return Promise.resolve();
    }
}