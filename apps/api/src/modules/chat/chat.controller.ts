import { Body, Controller, Get, Inject, Param, Post, Req, Sse } from "@nestjs/common";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { ok } from "../../common/response.js";
import { ChatService } from "./chat.service.js";
import { RateLimit } from "../rate-limit/rate-limit.decorator.js";
import { AuditAction } from "../audit/audit.decorator.js";
import { AccessControlService } from "../auth/access-control.service.js";

interface AuthenticatedRequest {
  user?: { id: string; email: string; displayName: string };
}

class ChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  conversationId?: string;
}

class CreateConversationDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;
}

@Controller("chat")
export class ChatController {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
  ) {}

  @Get("conversations")
  async conversations(@Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "chat:use");
    return ok(await this.chat.listConversations(request.user?.id));
  }

  @Post("conversations")
  async createConversation(@Body() body: CreateConversationDto, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "chat:use");
    return ok(await this.chat.createConversation(request.user?.id, body.title));
  }

  @Get("conversations/:id/messages")
  async messages(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "chat:use");
    return ok(await this.chat.listMessages(id, request.user?.id));
  }

  @RateLimit({ name: "chat-turn", limit: 30, windowSeconds: 60, identity: "user" })
  @AuditAction({ action: "提交对话查询", resource: "Web Chat" })
  @Post("turns")
  async turn(@Body() body: ChatDto, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "chat:use");
    return ok(await this.chat.start(body.message.trim(), body.conversationId, request.user?.id));
  }

  @Sse("turns/:id/events")
  async events(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "chat:use");
    return this.chat.events(id, request.user?.id);
  }

  @Post("turns/:id/cancel")
  async cancel(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "chat:use");
    return ok(await this.chat.cancel(id, request.user?.id));
  }
}
