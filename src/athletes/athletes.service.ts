import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateAthleteDto } from "./dto/create-athlete.dto";
import { UpdateAthleteConditionDto } from "./dto/update-athlete-condition.dto";
import { ACTIVE_CONDITION, ATHLETE_CONDITION_LABELS, AthleteCondition, todayInParis } from "./athlete-condition";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { formatTrainingDate, toNotificationRows } from "../notifications/notifications.util";
import { ATHLETE_CONDITION_UPDATED, ATHLETE_RESOURCE } from "../notifications/notification.constants";

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  nom: true,
  prenom: true,
  langue: true,
  created_at: true,
  updated_at: true,
} as const;

@Injectable()
export class AthletesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsRepository,
  ) {}

  // État de forme déclaré par l'athlète. Seul l'état actuel est conservé.
  // Repasser "actif" efface note et date de retour (jamais une ancienne
  // blessure affichée à côté de "Actif"). Les coachs de l'athlète
  // (coach_athlete) reçoivent UNE notification COACH par changement réel —
  // rejouer la même requête ne notifie personne (idempotence), dans la même
  // transaction que l'écriture (tout ou rien).
  async updateCondition(athleteId: string, actorUserId: string, dto: UpdateAthleteConditionDto, now: Date = new Date()) {
    const status = dto.status as AthleteCondition;
    const isActive = status === ACTIVE_CONDITION;
    const note = isActive ? null : dto.note?.trim() || null;
    const expectedReturn = isActive ? null : (dto.expectedReturn ?? null);

    if (expectedReturn !== null) {
      const [y, m, d] = expectedReturn.split("-").map(Number);
      const asDate = new Date(Date.UTC(y, m - 1, d));
      if (asDate.getUTCFullYear() !== y || asDate.getUTCMonth() !== m - 1 || asDate.getUTCDate() !== d) {
        throw new BadRequestException("expectedReturn n'est pas une date valide");
      }
      if (expectedReturn < todayInParis(now)) {
        throw new BadRequestException("La date de retour prévue ne peut pas être déjà passée");
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.athlete.findUnique({
        where: { id: athleteId },
        select: {
          etat_forme: true,
          etat_forme_note: true,
          etat_forme_retour: true,
          etat_forme_updated_at: true,
          app_user: { select: { prenom: true, nom: true } },
          coach_athlete: { select: { coach_profile: { select: { user_id: true } } } },
        },
      });
      if (!current) {
        throw new NotFoundException(`Athlete ${athleteId} introuvable`);
      }

      const currentReturn = current.etat_forme_retour ? current.etat_forme_retour.toISOString().slice(0, 10) : null;
      const unchanged =
        current.etat_forme === status && (current.etat_forme_note ?? null) === note && currentReturn === expectedReturn;
      if (unchanged) {
        return toConditionView(current.etat_forme, current.etat_forme_note, currentReturn, current.etat_forme_updated_at);
      }

      const updated = await tx.athlete.update({
        where: { id: athleteId },
        data: {
          etat_forme: status,
          etat_forme_note: note,
          etat_forme_retour: expectedReturn ? new Date(`${expectedReturn}T00:00:00.000Z`) : null,
          etat_forme_updated_at: now,
        },
        select: { etat_forme_updated_at: true },
      });

      const coachUserIds = [...new Set(current.coach_athlete.map((link) => link.coach_profile.user_id))];
      const name = [current.app_user.prenom, current.app_user.nom].filter(Boolean).join(" ") || "Un athlète";
      const details = [
        note,
        expectedReturn ? `retour prévu le ${formatTrainingDate(new Date(`${expectedReturn}T12:00:00.000Z`))}` : null,
      ].filter(Boolean);
      await this.notifications.createMany(
        tx,
        toNotificationRows(coachUserIds, {
          actorUserId,
          context: "COACH",
          type: ATHLETE_CONDITION_UPDATED,
          title: isActive ? `${name} est de nouveau disponible` : `${name} : ${ATHLETE_CONDITION_LABELS[status]}`,
          message: isActive
            ? `${name} a repassé son état à Actif.`
            : `${name} a indiqué : ${ATHLETE_CONDITION_LABELS[status]}${details.length ? ` — ${details.join(", ")}` : ""}.`,
          resourceType: ATHLETE_RESOURCE,
          resourceId: athleteId,
        }),
      );

      return toConditionView(status, note, expectedReturn, updated.etat_forme_updated_at);
    });
  }

  // `passwordHash` est optionnel et réservé à un appel interne (AuthService,
  // via /auth/register) : il n'existe plus de route publique exposant
  // CreateAthleteDot sans passer par une invitation valide (voir ticket
  // "Clubs, invitations & inscription Athlete contrôlée V1" §"SUPPRIMER
  // L'INSCRIPTION ATHLETE LIBRE" — l'ancien POST /athletes public a été
  // retiré, cette méthode ne reste appelable qu'en interne).
  async create(dto: CreateAthleteDto, passwordHash?: string) {
    try {
      return await this.prisma.$transaction((tx) => this.createWithinTransaction(tx, dto, passwordHash));
    } catch (error) {
      throw mapAthleteCreationError(error);
    }
  }

  // Extrait de create() pour permettre à AuthService.register (inscription
  // via invitation) d'inclure la création app_user+athlete dans SA PROPRE
  // transaction, plus large (consommation invitation + coach_athlete +
  // groupe optionnel — voir ticket §"TRANSACTION REGISTER") : Prisma ne
  // permet pas d'imbriquer deux $transaction distinctes, donc jamais
  // d'appel à create() depuis un contexte déjà transactionnel.
  async createWithinTransaction(tx: Prisma.TransactionClient, dto: CreateAthleteDto, passwordHash?: string) {
    const user = await tx.app_user.create({
      data: {
        email: dto.email,
        password_hash: passwordHash,
        nom: dto.nom,
        prenom: dto.prenom,
      },
      select: SAFE_USER_SELECT,
    });

    if (dto.clubId) {
      const club = await tx.club.findUnique({ where: { id: dto.clubId } });
      if (!club) {
        throw new NotFoundException(`Club ${dto.clubId} introuvable`);
      }
    }

    return tx.athlete.create({
      data: {
        user_id: user.id,
        club_id: dto.clubId,
        categorie_age: dto.categorieAge,
        genre: dto.genre,
        grade: dto.grade,
        date_naissance: dto.dateNaissance ? new Date(dto.dateNaissance) : undefined,
        niveau_sportif: dto.niveauSportif,
      },
      include: {
        club: true,
        app_user: { select: SAFE_USER_SELECT },
      },
    });
  }

  async findOne(id: string) {
    try {
      const athlete = await this.prisma.athlete.findUnique({
        where: { id },
        include: {
          club: true,
          app_user: { select: SAFE_USER_SELECT },
        },
      });

      if (!athlete) {
        throw new NotFoundException(`Athlete ${id} introuvable`);
      }

      return athlete;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException("Une erreur inattendue est survenue");
    }
  }
}

// Politique d'erreurs de création athlete, extraite pour être réutilisée par
// AuthService.register (inscription via invitation, transaction plus large
// englobant aussi la consommation d'invitation — voir ticket §"TRANSACTION
// REGISTER") sans dupliquer cette logique. `HttpException` couvre toute
// exception Nest déjà levée intentionnellement pendant la transaction (ex.
// club introuvable ci-dessus, ou une erreur d'invitation propagée par
// InvitationsService.redeem) : toujours rethrow telle quelle, jamais
// remplacée par un message générique.
export function mapAthleteCreationError(error: unknown): Error {
  if (error instanceof HttpException) {
    return error;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return new ConflictException("Cet email est déjà utilisé");
    }
    if (error.code === "P2003" || error.code === "P2025") {
      return new NotFoundException("Club introuvable");
    }
  }
  return new InternalServerErrorException("Une erreur inattendue est survenue");
}

function toConditionView(status: string, note: string | null, expectedReturn: string | null, updatedAt: Date | null) {
  return { status, note, expectedReturn, updatedAt };
}
