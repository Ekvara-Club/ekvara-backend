import {
  ConflictException,
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
  // via /auth/register) : POST /athletes (CreateAthleteDto) ne l'expose pas,
  // son comportement public est inchangé.
  async create(dto: CreateAthleteDto, passwordHash?: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
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
      });
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002") {
          throw new ConflictException("Cet email est déjà utilisé");
        }
        if (error.code === "P2003" || error.code === "P2025") {
          throw new NotFoundException("Club introuvable");
        }
      }
      throw new InternalServerErrorException("Une erreur inattendue est survenue");
    }
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
