import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from "class-validator";
import type { FastifyRequest } from "fastify";
import { ok } from "../../common/response.js";
import { ModelProviderService, type ModelProfileKey, type ModelProviderType } from "./model-provider.service.js";

interface AuthenticatedRequest extends FastifyRequest {
  user?: { id: string; email: string; displayName: string };
}

class CreateProviderDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsIn(["openai-compatible", "anthropic"]) type!: ModelProviderType;
  @IsUrl({ require_protocol: true }) @MaxLength(2048) baseUrl!: string;
  @IsString() @MinLength(8) @MaxLength(4096) apiKey!: string;
  @IsString() @MinLength(1) @MaxLength(200) defaultModel!: string;
}

class UpdateProviderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsIn(["openai-compatible", "anthropic"]) type?: ModelProviderType;
  @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(2048) baseUrl?: string;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(4096) apiKey?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) defaultModel?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class AssignProfileDto {
  @IsString() @MaxLength(100) providerId!: string;
  @IsString() @MinLength(1) @MaxLength(200) model!: string;
}

@Controller("model-providers")
export class ModelProviderController {
  constructor(@Inject(ModelProviderService) private readonly models: ModelProviderService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    await this.models.assertManager(request.user?.id);
    return ok(await this.models.list());
  }

  @Get("profiles")
  async profiles(@Req() request: AuthenticatedRequest) {
    await this.models.assertManager(request.user?.id);
    return ok(await this.models.profiles());
  }

  @Post()
  async create(@Body() body: CreateProviderDto, @Req() request: AuthenticatedRequest) {
    await this.models.assertManager(request.user?.id);
    return ok(await this.models.create(body, request.user?.id));
  }

  @Patch("profiles/:key")
  async assign(@Param("key") rawKey: string, @Body() body: AssignProfileDto, @Req() request: AuthenticatedRequest) {
    await this.models.assertManager(request.user?.id);
    const key = profileKey(rawKey);
    return ok(await this.models.assignProfile(key, body.providerId, body.model, request.user?.id));
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: UpdateProviderDto, @Req() request: AuthenticatedRequest) {
    await this.models.assertManager(request.user?.id);
    return ok(await this.models.update(id, body, request.user?.id));
  }

  @Delete(":id")
  async disable(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    await this.models.assertManager(request.user?.id);
    return ok(await this.models.disable(id, request.user?.id));
  }

  @Get(":id/models")
  async discover(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    await this.models.assertManager(request.user?.id);
    return ok(await this.models.discoverModels(id));
  }

  @Post(":id/test")
  async test(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    await this.models.assertManager(request.user?.id);
    return ok(await this.models.test(id, request.user?.id));
  }
}

function profileKey(value: string): ModelProfileKey {
  if (value === "default_chat_model" || value === "analysis_model" || value === "fallback_model") return value;
  throw new Error("MODEL_PROFILE_INVALID");
}
