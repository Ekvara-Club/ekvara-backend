import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { CoachRepository } from "./coach.repository";
import { CoachCompetitionPreparation, CoachCompetitionPreparationsRepository } from "./coach-competition-preparations.repository";
import { CreateCoachCompetitionPreparationDto } from "./dto/create-coach-competition-preparation.dto";
import { UpdateCoachCompetitionPreparationDto } from "./dto/update-coach-competition-preparation.dto";
import { DEFAULT_PREPARATION_STATUS } from "./coach-competition-preparation-status";

export interface CoachCompetitionPreparationView {
  id: string;
  athleteId: string;
  competitionId: string;
  status: string;
  targetAgeCategory: string | null;
  targetWeightCategory: string | null;
  objective: string | null;
  coachNote: string | null;
}

export function toPreparationView(row: CoachCompetitionPreparation): CoachCompetitionPreparationView {
  return {
    id: row.id,
    athleteId: row.athlete_id,
    competitionId: row.competition_id,
    status: row.statut,
    targetAgeCategory: row.categorie_age_prevue,
    targetWeightCategory: row.categorie_poids_prevue,
    objective: row.objectif,
    coachNote: row.note_coach,
  };
}

const DUPLICATE_MESSAGE = "Cet athlète a déjà une préparation pour cette compétition.";

// Ressource strictement privée au couple (coach, athlète, compétition) —
// jamais partagée entre deux coachs liés au même athlète (ticket §4/§42) :
// coach_id fait partie de la clé unique et de CHAQUE requête de lecture, un
// autre coach ne peut littéralement pas retrouver la ligne d'un confrère
// même en devinant son id (voir CoachPreparationOwnershipGuard, qui filtre
// déjà par coach_id avant que ce service ne soit jamais appelé).
@Injectable()
export class CoachCompetitionPreparationsService {
  constructor(
    private readonly coachRepository: CoachRepository,
    private readonly repository: CoachCompetitionPreparationsRepository,
  ) {}

  async createPreparation(
    coachId: string,
    competitionId: string,
    dto: CreateCoachCompetitionPreparationDto,
  ): Promise<CoachCompetitionPreparationView> {
    // Ticket §17 : athleteId doit appartenir au roster de CE coach — jamais
    // un athlète arbitraire, réutilise la vérification déjà établie
    // (CoachRepository.coachAthleteExists, même requête que
    // CoachAthleteAccessGuard) plutôt que d'en dupliquer une nouvelle.
    const belongsToRoster = await this.coachRepository.coachAthleteExists(coachId, dto.athleteId);
    if (!belongsToRoster) {
      throw new ForbiddenException("Cet athlète n'est pas dans ton roster");
    }

    const competitionExists = await this.repository.competitionExists(competitionId);
    if (!competitionExists) {
      throw new NotFoundException(`Compétition ${competitionId} introuvable`);
    }

    const existing = await this.repository.findByCoachAthleteCompetition(coachId, dto.athleteId, competitionId);
    if (existing) {
      throw new ConflictException(DUPLICATE_MESSAGE);
    }

    try {
      const created = await this.repository.create(coachId, dto.athleteId, competitionId, {
        statut: dto.status ?? DEFAULT_PREPARATION_STATUS,
        categorie_age_prevue: dto.targetAgeCategory,
        categorie_poids_prevue: dto.targetWeightCategory,
        objectif: dto.objective,
        note_coach: dto.coachNote,
      });
      return toPreparationView(created);
    } catch (error) {
      // Filet de sécurité contre une création concurrente (ticket §32) : la
      // contrainte unique (coach_id, athlete_id, competition_id) en base
      // reste la protection finale, même politique que
      // ParticipationsService.participate.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(DUPLICATE_MESSAGE);
      }
      throw error;
    }
  }

  // preparationId déjà vérifié comme appartenant à ce coach par
  // CoachPreparationOwnershipGuard avant que ce service ne soit appelé —
  // aucune revérification ici, le DTO n'accepte de toute façon ni coachId ni
  // athleteId (ticket §18, impossible de détourner une préparation vers un
  // autre athlète ou un autre coach).
  async updatePreparation(preparationId: string, dto: UpdateCoachCompetitionPreparationDto): Promise<CoachCompetitionPreparationView> {
    const updated = await this.repository.update(preparationId, {
      statut: dto.status,
      categorie_age_prevue: dto.targetAgeCategory,
      categorie_poids_prevue: dto.targetWeightCategory,
      objectif: dto.objective,
      note_coach: dto.coachNote,
    });
    return toPreparationView(updated);
  }

  // "Retirer de la préparation" (ticket §15, CRITIQUE) : supprime
  // UNIQUEMENT cette ligne coach_competition_preparation. Ne touche jamais
  // participation, athlete, coach_athlete — hard delete choisi (ticket §19)
  // car aucun historique de préparation n'est requis par cette V1, cohérent
  // avec le précédent déjà majoritaire dans ce module (coach_exercises,
  // coach_groups : hard delete 204 ; seul coach_trainings soft-cancel, pour
  // une raison spécifique à l'historique de présence qui ne s'applique pas
  // ici).
  async deletePreparation(preparationId: string): Promise<void> {
    await this.repository.delete(preparationId);
  }
}
