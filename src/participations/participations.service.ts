import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { competition as CompetitionModel, Prisma } from "../../generated/prisma/client";
import { CompetitionsRepository } from "../competitions/competitions.repository";
import { CreateParticipationDto } from "./dto/create-participation.dto";
import { UpdateParticipationResultDto } from "./dto/update-participation-result.dto";
import { ParticipationsRepository, ParticipationWithCompetition } from "./participations.repository";
import {
  AthleteCoachPreparationSummary,
  AthleteCoachPreparationView,
  isActivePreparation,
  resolveCoachPreparations,
  toPreparationSummary,
} from "./athlete-coach-preparations";
import { toCompetitionView } from "./participation-views";

@Injectable()
export class ParticipationsService {
  constructor(
    private readonly participationsRepository: ParticipationsRepository,
    private readonly competitionsRepository: CompetitionsRepository,
  ) {}

  async participate(athleteId: string, competitionId: string, dto: CreateParticipationDto) {
    await this.assertAthleteExists(athleteId);

    const competition = await this.competitionsRepository.findById(competitionId);
    if (!competition) {
      throw new NotFoundException(`Competition ${competitionId} introuvable`);
    }

    const existing = await this.participationsRepository.findByAthleteAndCompetition(
      athleteId,
      competitionId,
    );
    if (existing) {
      throw new ConflictException("L'athlète est déjà inscrit à cette compétition");
    }

    try {
      const created = await this.participationsRepository.create(athleteId, competitionId, dto);
      return toParticipationView(created);
    } catch (error) {
      // Filet de sécurité contre une inscription concurrente : la contrainte unique
      // (athlete_id, competition_id) en base reste la protection finale.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("L'athlète est déjà inscrit à cette compétition");
      }
      throw new InternalServerErrorException("Une erreur inattendue est survenue");
    }
  }

  async findAllForAthlete(athleteId: string) {
    await this.assertAthleteExists(athleteId);

    const participations = await this.participationsRepository.findAllByAthlete(athleteId);
    return participations.map(toParticipationView);
  }

  // Préparations coach de l'athlète (vue Athlete-safe, dédupliquée par
  // compétition, tous statuts et toutes dates — le frontend filtre). Ne
  // touche jamais `participation`.
  async findCoachPreparationsForAthlete(athleteId: string): Promise<AthleteCoachPreparationView[]> {
    await this.assertAthleteExists(athleteId);

    const rows = await this.participationsRepository.findCoachPreparationsByAthlete(athleteId);
    return resolveCoachPreparations(rows);
  }

  // "Prochaine compétition" = la plus proche parmi (A) la prochaine
  // participation active et (B) les préparations coach actives (non forfait)
  // de compétitions futures qui n'ont AUCUNE participation. Une compétition
  // présente dans les deux n'apparaît qu'une fois, portée par la
  // participation (source métier de l'inscription/du résultat), simplement
  // enrichie de la préparation. À date égale, la participation prime.
  async findNextForAthlete(athleteId: string) {
    await this.assertAthleteExists(athleteId);

    // competition.date_debut est un DATE (sans heure) : on compare à minuit UTC du
    // jour courant pour qu'une compétition ayant lieu aujourd'hui reste éligible,
    // au lieu de disparaître à cause de l'heure courante.
    const now = new Date();
    const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const [nextParticipation, preparationRows] = await Promise.all([
      this.participationsRepository.findNextByAthlete(athleteId, todayUtcMidnight),
      this.participationsRepository.findCoachPreparationsByAthlete(athleteId, todayUtcMidnight),
    ]);

    const activePreparations = resolveCoachPreparations(preparationRows).filter(isActivePreparation);

    let preparationOnly: AthleteCoachPreparationView | null = null;
    if (activePreparations.length > 0) {
      const withParticipation = new Set(
        await this.participationsRepository.findParticipationCompetitionIds(
          athleteId,
          activePreparations.map((p) => p.competitionId),
        ),
      );
      // activePreparations est déjà trié par date de début croissante.
      preparationOnly = activePreparations.find((p) => !withParticipation.has(p.competitionId)) ?? null;
    }

    if (nextParticipation && (!preparationOnly || nextParticipation.competition.date_debut <= preparationOnly.competition.dateDebut)) {
      const enrichment = activePreparations.find((p) => p.competitionId === nextParticipation.competition.id);
      return toNextParticipationView(nextParticipation, enrichment ? toPreparationSummary(enrichment) : null);
    }

    return preparationOnly ? toNextPreparationView(preparationOnly) : null;
  }

  async updateResult(athleteId: string, competitionId: string, dto: UpdateParticipationResultDto) {
    await this.assertAthleteExists(athleteId);

    const participation = await this.participationsRepository.findByAthleteAndCompetition(
      athleteId,
      competitionId,
    );
    if (!participation) {
      throw new NotFoundException(
        `Aucune participation trouvée pour l'athlète ${athleteId} et la compétition ${competitionId}`,
      );
    }

    // La FK participation.competition_id garantit l'existence de la compétition
    // tant que la participation existe : pas de vérification de nullité séparée.
    const competition = (await this.competitionsRepository.findById(competitionId)) as CompetitionModel;
    this.assertCompetitionIsOver(competition);

    assertAtLeastOneResultField(dto);

    const updated = await this.participationsRepository.updateResult(participation.id, {
      classement: dto.classement,
      medaille: dto.medaille,
      victoires: dto.victoires,
      defaites: dto.defaites,
    });

    return toParticipationView(updated);
  }

  // Compare des DATE (sans heure) à minuit UTC du jour courant, jamais à
  // l'heure courante : une compétition d'aujourd'hui ou encore en cours
  // (multi-jours) n'est jamais considérée comme terminée.
  private assertCompetitionIsOver(competition: Pick<CompetitionModel, "date_debut" | "date_fin">): void {
    const now = new Date();
    const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const effectiveEndDate = competition.date_fin ?? competition.date_debut;

    if (effectiveEndDate >= todayUtcMidnight) {
      throw new BadRequestException(
        "Le résultat ne peut être renseigné qu'une fois la compétition terminée",
      );
    }
  }

  private async assertAthleteExists(athleteId: string): Promise<void> {
    const exists = await this.participationsRepository.athleteExists(athleteId);
    if (!exists) {
      throw new NotFoundException(`Athlete ${athleteId} introuvable`);
    }
  }
}

// Vérifie la présence réelle d'une propriété (jamais sa véracité) : un champ
// explicitement fourni à 0 (ex. `victoires: 0`) ou à null (ex. `medaille:
// null`, pour retirer une médaille déjà enregistrée) doit être accepté comme
// "fourni", contrairement à un contrôle truthy/falsy qui le confondrait avec
// une absence.
function assertAtLeastOneResultField(dto: UpdateParticipationResultDto): void {
  const hasAnyField =
    dto.classement !== undefined ||
    dto.medaille !== undefined ||
    dto.victoires !== undefined ||
    dto.defaites !== undefined;

  if (!hasAnyField) {
    throw new BadRequestException(
      "Au moins un champ de résultat (classement, medaille, victoires, defaites) doit être fourni",
    );
  }
}

function toParticipationView(participation: ParticipationWithCompetition) {
  return {
    id: participation.id,
    statut: participation.statut,
    categoriePoids: participation.categorie_poids,
    categorieAge: participation.categorie_age,
    classement: participation.classement,
    medaille: participation.medaille,
    victoires: participation.victoires,
    defaites: participation.defaites,
    pointsGagnes: participation.points_gagnes,
    competition: toCompetitionView(participation.competition),
  };
}

// `source` + `participationId` nullable : le dashboard distingue une
// inscription officielle ("participation") d'une simple préparation coach
// ("coach_preparation", sans participationId/statut/catégories officiels).
// categoriePoids/categorieAge restent EXCLUSIVEMENT ceux de la participation ;
// les catégories prévues par le coach vivent dans `preparation`.
function toNextParticipationView(
  participation: ParticipationWithCompetition,
  preparation: AthleteCoachPreparationSummary | null,
) {
  return {
    source: "participation" as const,
    participationId: participation.id as string | null,
    statut: participation.statut as string | null,
    categoriePoids: participation.categorie_poids,
    categorieAge: participation.categorie_age,
    competition: toCompetitionView(participation.competition),
    preparation,
  };
}

function toNextPreparationView(preparation: AthleteCoachPreparationView) {
  return {
    source: "coach_preparation" as const,
    participationId: null as string | null,
    statut: null as string | null,
    categoriePoids: null as string | null,
    categorieAge: null as string | null,
    competition: preparation.competition,
    preparation: toPreparationSummary(preparation),
  };
}
