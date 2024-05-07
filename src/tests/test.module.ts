import { Module } from "@nestjs/common";
import { MyConfigService } from "./myconfig.service";
import { MyEmailService } from "./myemail.service";
import { MyUserService } from "./myuser.service";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { MongoDriver } from "@mikro-orm/mongodb";
import { MyUser } from "./entities/MyUser";
import { UserProfile } from "./entities/UserProfile";
import { FakeEmail } from "./entities/FakeEmail";
import { Melon } from "./entities/Melon";
import { OCRUDModule } from "../ocrud.module";
import { MelonService } from "./melon.service";
import { CRUD_CONFIG_KEY } from "../crud/crud.config.service";
import { MyProfileService } from "./profile.service";

export const getModule = (dbName) => { 
    return {
        imports: [
            MikroOrmModule.forRoot({
                entities: [MyUser, UserProfile, FakeEmail, Melon],
                driver: MongoDriver,
                dbName,
            }),
            OCRUDModule.forRoot(),
        ],
        controllers: [],
        providers: [MyEmailService, MyUserService, MelonService, MyProfileService,
            {
                provide: CRUD_CONFIG_KEY,
                useClass: MyConfigService,
              }
        ],
    }
}