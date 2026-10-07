import { Injectable, NotFoundException } from "@nestjs/common";
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
