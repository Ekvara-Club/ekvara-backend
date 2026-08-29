import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  nom: true,
  prenom: true,
} as const;

@Injectable()
export class CoachGroupsRepository {
  constructor(private readonly prisma: PrismaService) {}

  createGroup(coachId: string, name: string) {
    return this.prisma.coach_group.create({ data: { coach_id: coachId, name } });
  }

  // Utilisé par CoachGroupOwnershipGuard : lecture minimale (pas de members)
  // pour trancher rapidement l'accès avant toute autre requête.
  findOwnership(groupId: string) {
    return this.prisma.coach_group.findUnique({
      where: { id: groupId },
      select: { coach_id: true },
    });
  }

  findGroupsForCoach(coachId: string) {
    return this.prisma.coach_group.findMany({
      where: { coach_id: coachId },
      include: { _count: { select: { members: true } } },
    });
  }

  // Ticket "Dashboard groupe Coach V1" §6 : le hero du dashboard groupe n'a
  // besoin que du nom (le roster vient de CoachDashboardService.
  // getGroupRosterComputed, déjà propriétaire de coach_group_athlete) —
  // évite de refaire un aller-retour complet avec la liste des membres
  // (findGroupDetail) juste pour un nom.
  findNameForCoach(groupId: string) {
    return this.prisma.coach_group.findUnique({
      where: { id: groupId },
      select: { id: true, name: true },
    });
  }

  findGroupDetail(groupId: string) {
    return this.prisma.coach_group.findUnique({
      where: { id: groupId },
      include: {
        members: {
          include: {
            athlete: {
              select: {
                id: true,
                categorie_age: true,
                app_user: { select: SAFE_USER_SELECT },
              },
            },
          },
        },
      },
    });
  }

  renameGroup(groupId: string, name: string) {
    return this.prisma.coach_group.update({
      where: { id: groupId },
      data: { name },
      include: { _count: { select: { members: true } } },
    });
  }

  // onDelete: Cascade sur coach_group_athlete.group_id : la suppression des
  // memberships est gérée par Postgres, pas ici (voir schema.prisma).
  deleteGroup(groupId: string) {
    return this.prisma.coach_group.delete({ where: { id: groupId } });
  }

  membershipExists(groupId: string, athleteId: string): Promise<boolean> {
    return this.prisma.coach_group_athlete
      .findUnique({ where: { group_id_athlete_id: { group_id: groupId, athlete_id: athleteId } } })
      .then((m) => m !== null);
  }

  addMember(groupId: string, athleteId: string) {
    return this.prisma.coach_group_athlete.create({
      data: { group_id: groupId, athlete_id: athleteId },
    });
  }

  removeMember(groupId: string, athleteId: string) {
    return this.prisma.coach_group_athlete.delete({
      where: { group_id_athlete_id: { group_id: groupId, athlete_id: athleteId } },
    });
  }
}
