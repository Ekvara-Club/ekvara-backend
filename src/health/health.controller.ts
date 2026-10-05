import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

// Vérification de déploiement / supervision : l'API répond ET la base est
// joignable. Public, sans aucune donnée métier ni détail d'erreur (jamais le
// message Postgres brut, voir CLAUDE.md §26).
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: "error", database: "unreachable" });
    }
    return { status: "ok", database: "ok" };
  }
}
