import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateAthleteDto } from "./dto/create-athlete.dto";

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
  constructor(private readonly prisma: PrismaService) {}

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
