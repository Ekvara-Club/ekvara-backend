import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { training_session } from "../../generated/prisma/client";

// Convention métier interne (le schéma ne définit pas d'enum pour `statut`) :
// ces valeurs désignent une séance qui ne doit plus être considérée comme
// éligible pour le "prochain entraînement". Même approche que
// INACTIVE_PARTICIPATION_STATUSES dans le module participations.
const INACTIVE_TRAINING_STATUSES = ["annule"];

@Injectable()
export class TrainingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async athleteExists(athleteId: string): Promise<boolean> {
    const athlete = await this.prisma.athlete.findUnique({
      where: { id: athleteId },
      select: { id: true },
    });
    return athlete !== null;
  }

  createTraining(
    athleteId: string,
    data: {
      title: string;
      type?: string;
      subType?: string;
      startAt: Date;
      endAt?: Date;
      location?: string;
      level?: string;
      description?: string;
    },
  ): Promise<training_session> {
    return this.prisma.training_session.create({
      data: {
        athlete_id: athleteId,
        titre: data.title,
        type_seance: data.type,
        sous_type: data.subType,
        date_debut: data.startAt,
        date_fin: data.endAt,
        lieu: data.location,
        niveau: data.level,
        description: data.description,
      },
    });
  }

  // `range` filtre sur date_debut, bornes inclusives. Une séance est rattachée
  // à la période de sa date_debut uniquement (une séance commençant dimanche
  // soir et se terminant lundi reste dans le dimanche de la période demandée).
  findAllByAthlete(
    athleteId: string,
    range?: { from: Date; to: Date },
  ): Promise<training_session[]> {
    return this.prisma.training_session.findMany({
      where: {
        athlete_id: athleteId,
        ...(range ? { date_debut: { gte: range.from, lte: range.to } } : {}),
      },
      orderBy: { date_debut: "desc" },
    });
  }

  // "Prochain entraînement" : statut actif (pas annulé), et pas encore
  // terminée — date_fin >= maintenant si elle existe, sinon date_debut >=
  // maintenant (une séance sans date_fin disparaît dès qu'elle démarre,
  // comportement accepté pour le MVP). Tri date_debut asc, premier résultat.
  findNextByAthlete(athleteId: string, now: Date): Promise<training_session | null> {
    return this.prisma.training_session.findFirst({
      where: {
        athlete_id: athleteId,
        statut: { notIn: INACTIVE_TRAINING_STATUSES },
        OR: [{ date_fin: { gte: now } }, { date_fin: null, date_debut: { gte: now } }],
      },
      orderBy: { date_debut: "asc" },
    });
  }
}
