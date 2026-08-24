import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { AddCoachAthleteDto } from "./dto/add-coach-athlete.dto";
import { CoachRepository } from "./coach.repository";

@Injectable()
export class CoachService {
  constructor(private readonly coachRepository: CoachRepository) {}

  async getMe(coachId: string) {
    const profile = await this.coachRepository.findProfileById(coachId);
    if (!profile) {
      // Ne devrait pas arriver : coachId vient d'un JWT signé après vérification
      // de l'existence du profil (voir AuthService.login). Défensif uniquement.
      throw new NotFoundException(`Profil coach ${coachId} introuvable`);
    }
    return toCoachProfileView(profile);
  }

  // Ajout d'un athlète EXISTANT par email (décision produit MVP, voir ticket
  // §17) : ne crée jamais d'athlete/app_user, ne transfère jamais la
  // propriété du compte, n'envoie aucun mot de passe.
  async addAthleteByEmail(coachId: string, dto: AddCoachAthleteDto) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.coachRepository.findUserByEmailWithAthlete(email);

    if (!user) {
      throw new NotFoundException("Aucun compte trouvé pour cet email");
    }
    if (!user.athlete) {
      throw new BadRequestException("Ce compte n'a pas de profil athlète");
    }

    const alreadyLinked = await this.coachRepository.coachAthleteExists(coachId, user.athlete.id);
    if (alreadyLinked) {
      throw new ConflictException("Cet athlète est déjà dans votre groupe de gestion");
    }

    try {
      await this.coachRepository.createCoachAthlete(coachId, user.athlete.id);
    } catch (error) {
      // Filet de sécurité contre un ajout concurrent : la contrainte unique
      // (coach_id, athlete_id) en base reste la protection finale (même
      // pattern que ParticipationsService.participate).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("Cet athlète est déjà dans votre groupe de gestion");
      }
      throw error;
    }

    return { athleteId: user.athlete.id };
  }

  removeAthlete(coachId: string, athleteId: string): Promise<void> {
    return this.coachRepository.removeCoachAthlete(coachId, athleteId).then(() => undefined);
  }

  async listAthletes(coachId: string) {
    const links = await this.coachRepository.findAthletesForCoach(coachId);
    return links.map((link) => toCoachAthleteSummaryView(link.athlete)).sort(compareByNomPrenom);
  }
}

interface CoachProfileWithRelations {
  id: string;
  app_user: { id: string; email: string; nom: string | null; prenom: string | null };
  club: { id: string; nom: string; pays: string | null; ville: string | null } | null;
}

function toCoachProfileView(profile: CoachProfileWithRelations) {
  return {
    id: profile.id,
    user: {
      id: profile.app_user.id,
      prenom: profile.app_user.prenom,
      nom: profile.app_user.nom,
      email: profile.app_user.email,
    },
    club: profile.club
      ? { id: profile.club.id, nom: profile.club.nom, pays: profile.club.pays, ville: profile.club.ville }
      : null,
  };
}

interface AthleteSummary {
  id: string;
  categorie_age: string | null;
  grade: string | null;
  niveau_sportif: string | null;
  app_user: { nom: string | null; prenom: string | null };
}

function toCoachAthleteSummaryView(athlete: AthleteSummary) {
  return {
    id: athlete.id,
    prenom: athlete.app_user.prenom,
    nom: athlete.app_user.nom,
    categorieAge: athlete.categorie_age,
    // Aucune colonne "catégorie de poids" sur athlete : c'est une donnée liée
    // à une compétition précise (participation.categorie_poids), pas un
    // attribut permanent de l'athlète. Stub null en attendant que le ticket
    // dashboard (poids/progression) définisse comment la dériver.
    categoriePoids: null as string | null,
    grade: athlete.grade,
    niveauSportif: athlete.niveau_sportif,
  };
}

function compareByNomPrenom(
  a: { nom: string | null; prenom: string | null },
  b: { nom: string | null; prenom: string | null },
): number {
  const nomCompare = (a.nom ?? "").localeCompare(b.nom ?? "", "fr");
  if (nomCompare !== 0) {
    return nomCompare;
  }
  return (a.prenom ?? "").localeCompare(b.prenom ?? "", "fr");
}
