import { IsArray, IsInt, IsOptional, IsString } from "class-validator";
import { $MaxSize } from "../transform/decorators";
import { ICrudOptions } from "../../../shared/interfaces";

export class CrudOptions implements ICrudOptions  {

    @IsOptional()
    @IsArray()
    @IsString({each: true})
    @$MaxSize(300)
    populate?: string[];

    @IsOptional()
    @IsString()
    mockRole?: string;

    @IsOptional()
    @IsArray()
    @IsString({each: true})
    @$MaxSize(300)
    fields?: string[];

    @IsOptional()
    @IsInt()
    limit?: number;

    @IsOptional()
    @IsInt()
    offset?: number;

}