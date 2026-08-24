import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { CoachGroupsRepository } from "./coach-groups.repository";

@Injectable()
export class CoachGroupsService {
  constructor(private readonly coachGroupsRepository: CoachGroupsRepository) {}

  async createGroup(coachId: string, rawName: string) {
    const name = normalizeName(rawName);

    try {
      const created = await this.coachGroupsRepository.createGroup(coachId, name);
      return toGroupSummaryView({ ...created, _count: { members: 0 } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("Vous avez déjà un groupe avec ce nom");
      }
      throw error;
    }
  }

  async listGroups(coachId: string) {
    const groups = await this.coachGroupsRepository.findGroupsForCoach(coachId);
    return groups.map(toGroupSummaryView).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }

  async renameGroup(groupId: string, rawName: string) {
    const name = normalizeName(rawName);

    try {
      const updated = await this.coachGroupsRepository.renameGroup(groupId, name);
      return toGroupSummaryView(updated);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("Vous avez déjà un groupe avec ce nom");
      }
      throw error;
    }
  }

  deleteGroup(groupId: string): Promise<void> {
    return this.coachGroupsRepository.deleteGroup(groupId).then(() => undefined);
  }

  // CoachGroupOwnershipGuard a déjà vérifié que le groupe appartient au coach
  // connecté ; CoachAthleteAccessGuard a déjà vérifié que l'athlète lui est
  // assigné (coach_athlete). Cette combinaison de guards garantit à elle
  // seule la règle "jamais d'ajout si coach_athlete n'existe pas" (voir
  // ticket §25) : aucun contrôle redondant ici.
  async addAthlete(groupId: string, athleteId: string) {
    const alreadyMember = await this.coachGroupsRepository.membershipExists(groupId, athleteId);
    if (alreadyMember) {
      throw new ConflictException("Cet athlète est déjà dans ce groupe");
    }

    try {
      await this.coachGroupsRepository.addMember(groupId, athleteId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("Cet athlète est déjà dans ce groupe");
      }
      throw error;
    }
  }

  async removeAthlete(groupId: string, athleteId: string): Promise<void> {
    const isMember = await this.coachGroupsRepository.membershipExists(groupId, athleteId);
    if (!isMember) {
      throw new NotFoundException("Cet athlète n'est pas membre de ce groupe");
    }
    await this.coachGroupsRepository.removeMember(groupId, athleteId);
  }

  async getGroupDetail(groupId: string) {
    const group = await this.coachGroupsRepository.findGroupDetail(groupId);
    if (!group) {
      // Ne devrait pas arriver : CoachGroupOwnershipGuard a déjà résolu ce
      // groupe avant d'atteindre le service. Défensif uniquement.
      throw new NotFoundException(`Groupe ${groupId} introuvable`);
    }

    const athletes = group.members
      .map((member) => toGroupMemberView(member.athlete))
      .sort((a, b) => {
        const nomCompare = (a.nom ?? "").localeCompare(b.nom ?? "", "fr");
        return nomCompare !== 0 ? nomCompare : (a.prenom ?? "").localeCompare(b.prenom ?? "", "fr");
      });

    return { id: group.id, name: group.name, athletes };
  }
}

function normalizeName(rawName: string): string {
  const name = rawName.trim();
  if (!name) {
    throw new BadRequestException("Le nom du groupe ne peut pas être vide");
  }
  return name;
}

function toGroupSummaryView(group: { id: string; name: string; _count?: { members: number } }) {
  return { id: group.id, name: group.name, athleteCount: group._count?.members ?? 0 };
}

interface GroupMemberAthlete {
  id: string;
  categorie_age: string | null;
  app_user: { nom: string | null; prenom: string | null };
}

function toGroupMemberView(athlete: GroupMemberAthlete) {
  return {
    id: athlete.id,
    prenom: athlete.app_user.prenom,
    nom: athlete.app_user.nom,
    categorieAge: athlete.categorie_age,
    // Voir CoachService.toCoachAthleteSummaryView : pas de colonne "catégorie
    // de poids" sur athlete, stub null documenté.
    categoriePoids: null as string | null,
  };
}
