import { Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { createPrismaClient, type PrismaClient } from "@fuduo/database";

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  readonly enabled = process.env.DEMO_MODE !== "true";
  private client: PrismaClient | null = null;

  get prisma(): PrismaClient {
    if (!this.enabled) {
      throw new Error("Database access is disabled while DEMO_MODE is enabled");
    }
    this.client ??= createPrismaClient();
    return this.client;
  }

  async onModuleInit() {
    if (this.enabled) await this.prisma.$connect();
  }

  async ping(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown() {
    if (this.client) await this.client.$disconnect();
  }
}
