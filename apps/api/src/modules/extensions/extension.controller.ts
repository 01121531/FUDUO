import { Body, Controller, Get, Inject, Param, Post, Req } from "@nestjs/common";
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { ok } from "../../common/response.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { ExtensionService } from "./extension.service.js";
import type { ExtensionKind } from "./extension-schema.js";

interface AuthenticatedRequest { user?: { id: string } }

class CreateExtensionDto {
  @IsString() @MinLength(4) @MaxLength(4_000) prompt!: string;
  @IsOptional() @IsIn(["SKILL", "MCP"]) kind?: ExtensionKind;
}

@Controller("extensions")
export class ExtensionController {
  constructor(
    @Inject(ExtensionService) private readonly extensions: ExtensionService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const scope = await this.access.assertPermission(request.user?.id, "chat:use");
    const canManage = scope.permissions.includes("*") || scope.permissions.includes("extensions:manage");
    return ok(await this.extensions.list(request.user?.id, canManage));
  }

  @Post()
  async create(@Body() body: CreateExtensionDto, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "chat:use");
    return ok(await this.extensions.createDraft(body.prompt.trim(), request.user?.id, body.kind));
  }

  @Post(":id/install")
  async install(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "extensions:manage");
    return ok(await this.extensions.install(id, request.user?.id));
  }

  @Post(":id/reject")
  async reject(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "extensions:manage");
    return ok(await this.extensions.reject(id, request.user?.id));
  }
}
