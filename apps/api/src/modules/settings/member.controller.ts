import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import type { FastifyRequest } from "fastify";
import { ok } from "../../common/response.js";
import { MemberService, type MemberRoleCode } from "./member.service.js";

interface AuthenticatedRequest extends FastifyRequest { user?: { id: string } }

class CreateMemberDto {
  @IsString() @MinLength(1) @MaxLength(100) displayName!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(12) @MaxLength(128) temporaryPassword!: string;
  @IsIn(["ADMIN", "OPERATOR", "VIEWER"]) roleCode!: MemberRoleCode;
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) shopIds!: string[];
}

class UpdateMemberDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) displayName?: string;
  @IsOptional() @IsIn(["ADMIN", "OPERATOR", "VIEWER"]) roleCode?: MemberRoleCode;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) shopIds?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
}

class ResetPasswordDto {
  @IsString() @MinLength(12) @MaxLength(128) temporaryPassword!: string;
}

@Controller("settings/members")
export class MemberController {
  constructor(@Inject(MemberService) private readonly members: MemberService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) { return ok(await this.members.list(request.user?.id)); }

  @Get("options")
  async options(@Req() request: AuthenticatedRequest) { return ok(await this.members.options(request.user?.id)); }

  @Post()
  async create(@Body() body: CreateMemberDto, @Req() request: AuthenticatedRequest) { return ok(await this.members.create(body, request.user?.id)); }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: UpdateMemberDto, @Req() request: AuthenticatedRequest) { return ok(await this.members.update(id, body, request.user?.id)); }

  @Post(":id/reset-password")
  async resetPassword(@Param("id") id: string, @Body() body: ResetPasswordDto, @Req() request: AuthenticatedRequest) { return ok(await this.members.resetPassword(id, body.temporaryPassword, request.user?.id)); }
}
