import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

// Champs app_user jamais password_hash (voir AthletesService.SAFE_USER_SELECT,
// même politique appliquée ici indépendamment pour ne pas coupler les modules
// coach et athletes sur une constante interne à ce dernier).
const SAFE_USER_SELECT = {
  id: true,
  email: true,
  nom: true,
  prenom: true,
} as const;

@Injectable()
export class CoachRepository {
  constructor(private readonly prisma: PrismaService) {}

  findProfileByUserId(userId: string) {
    return this.prisma.coach_profile.findUnique({
      where: { user_id: userId },
      include: { app_user: { select: SAFE_USER_SELECT }, club: true },
    });
  }

  findProfileById(coachId: string) {
    return this.prisma.coach_profile.findUnique({
      where: { id: coachId },
      include: { app_user: { select: SAFE_USER_SELECT }, club: true },
    });
  }

  // Utilisé par POST /coach/athletes (ajout par email) : ne renvoie jamais
  // password_hash, uniquement ce qui est nécessaire pour vérifier l'existence
  // du compte et de son profil athlète.
  coachAthleteExists(coachId: string, athleteId: string): Promise<boolean> {
    return this.prisma.coach_athlete
      .findUnique({ where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteId } } })
      .then((link) => link !== null);
  }

  createCoachAthlete(coachId: string, athleteId: string) {
    return this.prisma.coach_athlete.create({
      data: { coach_id: coachId, athlete_id: athleteId },
    });
  }

  // Transactionnelle : retire d'abord les memberships de l'athlète dans les
  // groupes DE CE COACH (jamais ceux d'un autre coach qui gérerait le même
  // athlète — cas hybride/partagé), puis le lien coach_athlete lui-même. Voir
  // ticket §18 : ne doit jamais toucher athlete/app_user/poids/objectifs/etc.
  removeCoachAthlete(coachId: string, athleteId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.coach_group_athlete.deleteMany({
        where: { athlete_id: athleteId, coach_group: { coach_id: coachId } },
      });
      await tx.coach_athlete.delete({
        where: { coach_id_athlete_id: { coach_id: coachId, athlete_id: athleteId } },
      });
    });
  }

  findAthletesForCoach(coachId: string) {
    return this.prisma.coach_athlete.findMany({
      where: { coach_id: coachId },
      include: {
        athlete: {
          select: {
            id: true,
            categorie_age: true,
            grade: true,
            niveau_sportif: true,
            etat_forme: true,
            etat_forme_note: true,
            etat_forme_retour: true,
            etat_forme_updated_at: true,
            wt_link: {
              select: { status: true, external_athlete: { select: { id: true, display_name: true, country_code: true } } },
            },
            app_user: { select: SAFE_USER_SELECT },
          },
        },
      },
    });
  }
}
