import { randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@fuduo/database";
import { DatabaseService } from "../database/database.service.js";
import { ModelProviderService } from "../models/model-provider.service.js";
import { OpenClawAdminService } from "../settings/openclaw-admin.service.js";
import {
  fallbackExtensionCandidate,
  parseExtensionCandidate,
  validateExtensionCandidate,
  type ExtensionCandidate,
  type ExtensionKind,
  type ExtensionValidation,
} from "./extension-schema.js";

export interface DemoExtension extends ExtensionCandidate {
  id: string;
  ownerId: string;
  status: string;
  version: number;
  validation: ExtensionValidation;
  installedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ExtensionService {
  private readonly demoExtensions = new Map<string, DemoExtension>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ModelProviderService) private readonly models: ModelProviderService,
    @Inject(OpenClawAdminService) private readonly openclaw: OpenClawAdminService,
  ) {}

  async createDraft(prompt: string, ownerId?: string, kindHint?: ExtensionKind, signal?: AbortSignal) {
    const actorId = ownerId ?? (this.database.enabled ? undefined : "demo-user");
    if (!actorId) throw new Error("AUTH_REQUIRED");
    const requested = kindHint ? `${kindHint}: ${prompt}` : prompt;
    const modelResult = await this.models.generateExtension(requested, signal).catch(() => null);
    const parsed = parseExtensionCandidate(modelResult?.content);
    const candidate = parsed && (!kindHint || parsed.kind === kindHint)
      ? parsed
      : fallbackExtensionCandidate(prompt, kindHint);
    const validation = validateExtensionCandidate(candidate);
    const status = validation.errors.length ? "DRAFT" : "VALIDATED";
    const now = new Date().toISOString();

    if (!this.database.enabled) {
      const version = 1 + Math.max(0, ...[...this.demoExtensions.values()].filter((item) => item.slug === candidate.slug).map((item) => item.version));
      const row: DemoExtension = { ...candidate, id: `extension_${randomUUID()}`, ownerId: actorId, status, version, validation, installedAt: null, createdAt: now, updatedAt: now };
      this.demoExtensions.set(row.id, row);
      return row;
    }

    const previous = await this.database.prisma.aiExtension.findFirst({ where: { slug: candidate.slug }, orderBy: { version: "desc" }, select: { version: true } });
    const row = await this.database.prisma.aiExtension.create({
      data: {
        ownerId: actorId,
        kind: candidate.kind,
        name: candidate.name,
        slug: candidate.slug,
        description: candidate.description,
        status,
        version: (previous?.version ?? 0) + 1,
        manifest: candidate.manifest as Prisma.InputJsonObject,
        files: candidate.files as unknown as Prisma.InputJsonArray,
        validation: validation as unknown as Prisma.InputJsonObject,
      },
    });
    return serialize(row);
  }

  async list(ownerId: string | undefined, canManage: boolean) {
    const actorId = ownerId ?? (this.database.enabled ? undefined : "demo-user");
    if (!actorId) throw new Error("AUTH_REQUIRED");
    if (!this.database.enabled) {
      return [...this.demoExtensions.values()]
        .filter((item) => canManage || item.ownerId === actorId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    const rows = await this.database.prisma.aiExtension.findMany({
      where: canManage ? {} : { ownerId: actorId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map(serialize);
  }

  async install(id: string, actorId?: string) {
    const row = await this.find(id);
    const validation = validationFrom(row.validation);
    if (validation.errors.length) throw new Error("EXTENSION_VALIDATION_FAILED");
    if (row.status === "REJECTED") throw new Error("EXTENSION_REJECTED");
    const bundle = {
      kind: row.kind as ExtensionKind,
      slug: row.slug,
      version: row.version,
      manifest: asRecord(row.manifest),
      files: extensionFiles(row.files),
    };
    const runtime = this.openclaw.configured
      ? await this.openclaw.installExtension(bundle)
      : { installed: true, path: `demo/${row.slug}/${row.version}`, restartRequired: false };
    const installedAt = new Date();

    if (!this.database.enabled) {
      const current = this.demoExtensions.get(id)!;
      current.status = "INSTALLED";
      current.installedAt = installedAt.toISOString();
      current.updatedAt = current.installedAt;
      return { ...current, runtime };
    }
    const updated = await this.database.prisma.$transaction(async (transaction) => {
      const extension = await transaction.aiExtension.update({ where: { id }, data: { status: "INSTALLED", installedAt } });
      await transaction.auditLog.create({
        data: { ...(actorId ? { userId: actorId } : {}), channel: "WEB", action: "Install AI extension", resource: `${row.slug}@${row.version}`, result: "SUCCEEDED", traceId: randomUUID() },
      });
      return extension;
    });
    return { ...serialize(updated), runtime };
  }

  async reject(id: string, actorId?: string) {
    const existing = await this.find(id);
    if (existing.status === "INSTALLED") throw new Error("EXTENSION_INSTALLED");
    if (!this.database.enabled) {
      const row = this.demoExtensions.get(id)!;
      row.status = "REJECTED";
      row.updatedAt = new Date().toISOString();
      return row;
    }
    const updated = await this.database.prisma.$transaction(async (transaction) => {
      const extension = await transaction.aiExtension.update({ where: { id }, data: { status: "REJECTED" } });
      await transaction.auditLog.create({ data: { ...(actorId ? { userId: actorId } : {}), channel: "WEB", action: "Reject AI extension", resource: id, result: "SUCCEEDED", traceId: randomUUID() } });
      return extension;
    });
    return serialize(updated);
  }

  private async find(id: string) {
    if (!this.database.enabled) {
      const row = this.demoExtensions.get(id);
      if (!row) throw new NotFoundException({ code: "EXTENSION_NOT_FOUND", message: "扩展草案不存在" });
      return row;
    }
    const row = await this.database.prisma.aiExtension.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: "EXTENSION_NOT_FOUND", message: "扩展草案不存在" });
    return row;
  }
}

function serialize(row: {
  id: string; ownerId: string; kind: string; name: string; slug: string; description: string; status: string; version: number;
  manifest: unknown; files: unknown; validation: unknown; installedAt: Date | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    ...row,
    manifest: asRecord(row.manifest),
    files: extensionFiles(row.files),
    validation: validationFrom(row.validation),
    installedAt: row.installedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function validationFrom(value: unknown): ExtensionValidation {
  const record = asRecord(value);
  return { errors: Array.isArray(record.errors) ? record.errors.map(String) : ["VALIDATION_MISSING"], warnings: Array.isArray(record.warnings) ? record.warnings.map(String) : [] };
}
function extensionFiles(value: unknown) {
  if (!Array.isArray(value)) throw new Error("EXTENSION_FILES_INVALID");
  return value.map((item) => {
    const record = asRecord(item);
    if (typeof record.path !== "string" || typeof record.content !== "string") throw new Error("EXTENSION_FILES_INVALID");
    return { path: record.path, content: record.content };
  });
}
