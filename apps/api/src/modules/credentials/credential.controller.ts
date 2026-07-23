import { Body, Controller, Delete, Get, Inject, Post, Req } from "@nestjs/common";
import { IsString, MinLength } from "class-validator";
import { ok } from "../../common/response.js";
import { CredentialService } from "./credential.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuditAction } from "../audit/audit.decorator.js";

interface AuthenticatedRequest { user?: { id: string } }

class ImportTokenDto {
  @IsString()
  @MinLength(20)
  authorization!: string;
}

@Controller("fuduo/credential")
export class CredentialController {
  constructor(
    @Inject(CredentialService) private readonly credentials: CredentialService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
  ) {}

  @AuditAction({ action: "查询富多授权状态", resource: "富多账号" })
  @Get("status")
  async status(@Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "settings:erp");
    return ok(await this.credentials.readStatus());
  }

  @AuditAction({ action: "导入富多授权", resource: "富多账号" })
  @Post("import")
  async import(@Body() body: ImportTokenDto, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "settings:erp");
    return ok(await this.credentials.importToken(body.authorization, true));
  }

  @AuditAction({ action: "刷新富多授权", resource: "富多账号" })
  @Post("refresh")
  async refresh(@Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "settings:erp");
    return ok(await this.credentials.refresh());
  }

  @AuditAction({ action: "撤销富多授权", resource: "富多账号" })
  @Delete()
  async revoke(@Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "settings:erp");
    return ok(await this.credentials.revoke());
  }
}
