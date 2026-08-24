import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface ResolvedDestinataires {
  athleteIds: string[];
  groupIds: string[];
}

// Résolution + autorisation des destinataires (groupes + athlètes
// individuels) : RÈGLE PARTAGÉE entre les séances collectives (ticket
// "Entraînements collectifs Coach") et la publication d'exercices (ce
// ticket) — même autorisation exacte (chaque groupId appartient au coach,
// chaque athleteId est dans coach_athlete), même politique d'échec complet
// sur UN seul destinataire invalide, même dédoublonnage par union. Extrait
// ici pour ne jamais la coder une seconde fois avec un risque de divergence
// (voir CLAUDE.md / principe "ne duplique jamais une règle métier").
//
// Interroge coach_group/coach_athlete/coach_group_athlete directement (pas
// via CoachGroupsRepository/CoachRepository) : reste un composant minimal et
// indépendant du reste de CoachModule, injectable par n'importe quel futur
// module coach qui a besoin de cette même règle (exercices, plus tard
// éventuellement d'autres ressources publiables).
@Injectable()
export class CoachDestinataireResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(coachId: string, groupIds: string[], athleteIds: string[]): Promise<ResolvedDestinataires> {
    if (groupIds.length > 0) {
      const owned = await this.prisma.coach_group.findMany({
        where: { id: { in: groupIds }, coach_id: coachId },
        select: { id: true },
      });
      if (owned.length !== new Set(groupIds).size) {
        throw new ForbiddenException("Un ou plusieurs groupes n'appartiennent pas à ce coach");
      }
    }

    if (athleteIds.length > 0) {
      const linked = await this.prisma.coach_athlete.findMany({
        where: { coach_id: coachId, athlete_id: { in: athleteIds } },
        select: { athlete_id: true },
      });
      if (linked.length !== new Set(athleteIds).size) {
        throw new ForbiddenException("Un ou plusieurs athlètes ne sont pas assignés à ce coach");
      }
    }

    const groupMembers =
      groupIds.length > 0
        ? await this.prisma.coach_group_athlete.findMany({
            where: { group_id: { in: groupIds } },
            select: { athlete_id: true },
          })
        : [];

    const union = new Set<string>([...groupMembers.map((m) => m.athlete_id), ...athleteIds]);

    if (union.size === 0) {
      throw new BadRequestException("Au moins un destinataire (groupe ou athlète) est requis");
    }

    return { athleteIds: [...union], groupIds: [...new Set(groupIds)] };
  }
}
