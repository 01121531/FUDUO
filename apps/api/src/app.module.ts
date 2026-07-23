import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { AnalyticsController } from "./modules/analytics/analytics.controller.js";
import { ChatController } from "./modules/chat/chat.controller.js";
import { ChatService } from "./modules/chat/chat.service.js";
import { CredentialController } from "./modules/credentials/credential.controller.js";
import { CredentialService } from "./modules/credentials/credential.service.js";
import { HealthController } from "./modules/health/health.controller.js";
import { MetricsController } from "./modules/health/metrics.controller.js";
import { MetricsService } from "./modules/health/metrics.service.js";
import { QrSessionController } from "./modules/qr-session/qr-session.controller.js";
import { QrSessionService } from "./modules/qr-session/qr-session.service.js";
import { SettingsController } from "./modules/settings/settings.controller.js";
import { OpenClawAdminService } from "./modules/settings/openclaw-admin.service.js";
import { ShopsController } from "./modules/shops/shops.controller.js";
import { DemoDataService } from "./modules/demo/demo-data.service.js";
import { SyncController } from "./modules/sync/sync.controller.js";
import { DatabaseService } from "./modules/database/database.service.js";
import { BusinessDataService } from "./modules/data/business-data.service.js";
import { SyncQueueService } from "./modules/sync/sync-queue.service.js";
import { BusinessToolController } from "./modules/tools/business-tool.controller.js";
import { BusinessToolService } from "./modules/tools/business-tool.service.js";
import { InternalServiceGuard } from "./modules/tools/internal-service.guard.js";
import { ToolInvocationDeduplicator } from "./modules/tools/tool-invocation-deduplicator.js";
import { ModelProviderController } from "./modules/models/model-provider.controller.js";
import { ModelProviderService } from "./modules/models/model-provider.service.js";
import { OpenClawModelController } from "./modules/models/openclaw-model.controller.js";
import { AuthController } from "./modules/auth/auth.controller.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { AuthGuard } from "./modules/auth/auth.guard.js";
import { ReportsController } from "./modules/reports/reports.controller.js";
import { ReportDeliveryController } from "./modules/reports/report-delivery.controller.js";
import { ReportDeliveryService } from "./modules/reports/report-delivery.service.js";
import { CredentialUploadController } from "./modules/credentials/credential-upload.controller.js";
import { CredentialAlertController } from "./modules/credentials/credential-alert.controller.js";
import { CredentialAlertService } from "./modules/credentials/credential-alert.service.js";
import { CaptureUploadGuard } from "./modules/credentials/capture-upload.guard.js";
import { AccessControlService } from "./modules/auth/access-control.service.js";
import { MemberController } from "./modules/settings/member.controller.js";
import { MemberService } from "./modules/settings/member.service.js";
import { RateLimitGuard } from "./modules/rate-limit/rate-limit.guard.js";
import { RateLimitService } from "./modules/rate-limit/rate-limit.service.js";
import { AuditInterceptor } from "./modules/audit/audit.interceptor.js";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [
    HealthController,
    MetricsController,
    AnalyticsController,
    ShopsController,
    SyncController,
    ChatController,
    CredentialController,
    QrSessionController,
    SettingsController,
    BusinessToolController,
    ModelProviderController,
    OpenClawModelController,
    AuthController,
    ReportsController,
    ReportDeliveryController,
    CredentialUploadController,
    CredentialAlertController,
    MemberController,
  ],
  providers: [DatabaseService, MetricsService, AccessControlService, MemberService, DemoDataService, BusinessDataService, BusinessToolService, ToolInvocationDeduplicator, ChatService, InternalServiceGuard, ModelProviderService, OpenClawAdminService, ReportDeliveryService, AuthService, CredentialService, CredentialAlertService, CaptureUploadGuard, QrSessionService, SyncQueueService, RateLimitService, { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_GUARD, useClass: RateLimitGuard }, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AppModule {}
