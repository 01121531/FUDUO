import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import { IsString, MinLength } from "class-validator";
import { ok } from "../../common/response.js";
import { Public } from "../auth/public.decorator.js";
import { CaptureUploadGuard } from "./capture-upload.guard.js";
import { CredentialService } from "./credential.service.js";
import { RateLimit } from "../rate-limit/rate-limit.decorator.js";
import { AuditAction } from "../audit/audit.decorator.js";

class CaptureUploadDto {
  @IsString() @MinLength(20) authorization!: string;
}

@Controller("fuduo/credential")
export class CredentialUploadController {
  constructor(@Inject(CredentialService) private readonly credentials: CredentialService) {}

  @Public()
  @UseGuards(CaptureUploadGuard)
  @RateLimit({ name: "credential-upload", limit: 60, windowSeconds: 60, identity: "ip" })
  @AuditAction({ action: "插件上报富多授权", resource: "富多账号" })
  @Post("upload")
  async upload(@Body() body: CaptureUploadDto) {
    return ok(await this.credentials.importToken(body.authorization, true));
  }
}
