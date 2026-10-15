import { Injectable, Logger } from "@nestjs/common";

// Journal des opérations d'administration (décision D3 : logs structurés
// NestJS, conservés par pm2 en production — pas de table d'audit en V1).
// Une ligne JSON par événement, facile à filtrer ("AdminAudit"). Ne reçoit
// jamais de mot de passe, de jeton ni d'email : uniquement des identifiants
// techniques et des noms de champs.
export type AdminAuditDetails = Record<string, string | number | boolean | null | string[]>;

@Injectable()
export class AdminAuditLogger {
  private readonly logger = new Logger("AdminAudit");

  record(event: string, details: AdminAuditDetails = {}): void {
    this.logger.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
  }

  denied(event: string, details: AdminAuditDetails = {}): void {
    this.logger.warn(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
  }
}
