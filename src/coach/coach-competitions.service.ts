import { Injectable, NotFoundException } from "@nestjs/common";
import { CoachRepository } from "./coach.repository";
import { BatchParticipation, CoachCompetitionsRepository } from "./coach-competitions.repository";
import {
  BatchPreparationWithCompetition,
  CoachCompetitionPreparation,
  CoachCompetitionPreparationsRepository,
} from "./coach-competition-preparations.repository";

// ---------------------------------------------------------------------------
// Types de sortie (voir rapport final pour la justification de la forme)
// ---------------------------------------------------------------------------

export interface CoachCompetitionRef {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date | null;
  city: string | null;
  country: string | null;
  level: string | null;
}

export interface CoachCompetitionResultView {
  classement: number | null;
  medaille: string | null;
  victoires: number | null;
  defaites: number | null;
}

// null si le coach n'a pas (encore) de préparation interne pour cet athlète
// sur cette compétition — jamais un objet à champs tous null (voir ticket
// Sélection & préparation V1 §16, distinguer clairement "pas de
// préparation" de "préparation avec champs vides").
export interface CoachCompetitionPreparationSummary {
  id: string;
  status: string;
  targetAgeCategory: string | null;
  targetWeightCategory: string | null;
  objective: string | null;
  coachNote: string | null;
}

// Forme de GET /coach/competitions (liste groupée) : pas de groupes ni de
// préparation détaillée ici (jamais consommés par cette vue — éviter une
// requête/un champ non utilisé, ticket §6). ageCategory/weightCategory
// reflètent soit la participation officielle si elle existe, soit la
// catégorie PRÉVUE de la préparation à défaut (ticket §8) — jamais les deux
// mélangées : la participation officielle prime toujours quand les deux
// existent (ticket §7).
export interface CoachCompetitionListAthleteView {
  id: string;
  firstName: string | null;
  lastName: string | null;
  ageCategory: string | null;
  weightCategory: string | null;
  participationStatus: string | null;
  result: CoachCompetitionResultView;
}

export interface CoachCompetitionGroupView {
  competition: CoachCompetitionRef;
  athleteCount: number;
  athletes: CoachCompetitionListAthleteView[];
}

export interface CoachCompetitionsListView {
  upcoming: CoachCompetitionGroupView[];
  past: CoachCompetitionGroupView[];
}

// Forme de GET /coach/competitions/:competitionId : mêmes champs que la
// liste + groupes coach par athlète (ticket §9) + statut officiel/préparation
// fusionnés par athlète (ticket §7/§8/§13/§14). "Groupes du groupe" (§10) et
// "catégories du groupe" (§13) restent volontairement absents ici :
// dérivables intégralement côté frontend depuis athletes[], jamais un champ
// dupliqué renvoyé par le backend.
export interface CoachCompetitionDetailAthleteView extends CoachCompetitionListAthleteView {
  groups: { id: string; name: string }[];
  hasOfficialParticipation: boolean;
  preparation: CoachCompetitionPreparationSummary | null;
}

export interface CoachCompetitionDetailView {
  competition: CoachCompetitionRef;
  athleteCount: number;
  athletes: CoachCompetitionDetailAthleteView[];
}

interface AthleteBaseRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
}

const EMPTY_RESULT: CoachCompetitionResultView = { classement: null, medaille: null, victoires: null, defaites: null };

function toCompetitionRefFromParticipation(participation: BatchParticipation): CoachCompetitionRef {
  return {
    id: participation.competition.id,
    name: participation.competition.nom,
    startDate: participation.competition.date_debut,
    endDate: participation.competition.date_fin,
    city: participation.competition.ville,
    country: participation.competition.pays,
    level: participation.competition.niveau,
  };
}

function toCompetitionRefFromPreparation(preparation: BatchPreparationWithCompetition): CoachCompetitionRef {
  return {
    id: preparation.competition.id,
    name: preparation.competition.nom,
    startDate: preparation.competition.date_debut,
    endDate: preparation.competition.date_fin,
    city: preparation.competition.ville,
    country: preparation.competition.pays,
    level: preparation.competition.niveau,
  };
}

function toResultView(participation: BatchParticipation): CoachCompetitionResultView {
  return {
    classement: participation.classement,
    medaille: participation.medaille,
    victoires: participation.victoires,
    defaites: participation.defaites,
  };
}

function toPreparationSummary(preparation: CoachCompetitionPreparation | BatchPreparationWithCompetition): CoachCompetitionPreparationSummary {
  return {
    id: preparation.id,
    status: preparation.statut,
    targetAgeCategory: preparation.categorie_age_prevue,
    targetWeightCategory: preparation.categorie_poids_prevue,
    objective: preparation.objectif,
    coachNote: preparation.note_coach,
  };
}

// Une compétition est "passée" si sa date de fin (ou, à défaut, sa date de
// début) est strictement avant maintenant — même règle que
// isPastParticipation côté frontend athlète (EkvaraFrontend/utils/
// participationStats.ts), reproduite ici côté backend puisque c'est ici que
// se fait le tri upcoming/past (jamais une seconde règle divergente).
// Opère sur un CoachCompetitionRef déjà construit (pas directement sur une
// participation/préparation) : la règle est identique quelle que soit la
// source d'où vient la compétition.
function isPastCompetition(competition: CoachCompetitionRef, now: Date): boolean {
  const referenceDate = competition.endDate ?? competition.startDate;
  return referenceDate.getTime() < now.getTime();
}

@Injectable()
export class CoachCompetitionsService {
  constructor(
    private readonly coachRepository: CoachRepository,
    private readonly repository: CoachCompetitionsRepository,
    private readonly preparationsRepository: CoachCompetitionPreparationsRepository,
  ) {}

  private async resolveRosterBase(coachId: string): Promise<Map<string, AthleteBaseRow>> {
    const links = await this.coachRepository.findAthletesForCoach(coachId);
    const map = new Map<string, AthleteBaseRow>();
    for (const link of links) {
      map.set(link.athlete.id, {
        id: link.athlete.id,
        firstName: link.athlete.app_user.prenom,
        lastName: link.athlete.app_user.nom,
      });
    }
    return map;
  }

  // Point d'entrée unique pour GET /coach/competitions : UNION participation
  // officielle + préparation interne, dédupliquée par competition.id ET par
  // athlete.id (ticket §24/§25) — nombre de requêtes CONSTANT quel que soit
  // le nombre d'athlètes du roster (roster + 1 requête participations groupées
  // + 1 requête préparations groupées, en parallèle), jamais une boucle par
  // athlète (§6).
  async getCompetitions(coachId: string, now: Date = new Date()): Promise<CoachCompetitionsListView> {
    const athleteById = await this.resolveRosterBase(coachId);
    const athleteIds = [...athleteById.keys()];

    const [participations, preparations] = await Promise.all([
      this.repository.findParticipationsForAthletes(athleteIds),
      this.preparationsRepository.findForAthletesWithCompetition(athleteIds, coachId),
    ]);

    const byCompetition = new Map<string, { ref: CoachCompetitionRef; athletes: Map<string, CoachCompetitionListAthleteView> }>();

    function ensureEntry(ref: CoachCompetitionRef) {
      let entry = byCompetition.get(ref.id);
      if (!entry) {
        entry = { ref, athletes: new Map() };
        byCompetition.set(ref.id, entry);
      }
      return entry;
    }

    for (const participation of participations) {
      const athlete = athleteById.get(participation.athlete_id);
      if (!athlete) continue; // défensif : ne devrait pas arriver, athleteIds vient du même roster.

      const entry = ensureEntry(toCompetitionRefFromParticipation(participation));
      entry.athletes.set(athlete.id, {
        id: athlete.id,
        firstName: athlete.firstName,
        lastName: athlete.lastName,
        ageCategory: participation.categorie_age,
        weightCategory: participation.categorie_poids,
        participationStatus: participation.statut,
        result: toResultView(participation),
      });
    }

    for (const preparation of preparations) {
      const athlete = athleteById.get(preparation.athlete_id);
      // Athlète retiré du roster depuis la création de la préparation
      // (ticket §31) : la ligne reste en base pour historique, mais n'est
      // plus affichée comme si le coach pouvait encore agir dessus.
      if (!athlete) continue;

      const entry = ensureEntry(toCompetitionRefFromPreparation(preparation));
      // Une participation officielle déjà trouvée pour cet athlète sur cette
      // compétition prime toujours (ticket §7) : jamais écrasée par la
      // catégorie prévue de la préparation.
      if (!entry.athletes.has(athlete.id)) {
        entry.athletes.set(athlete.id, {
          id: athlete.id,
          firstName: athlete.firstName,
          lastName: athlete.lastName,
          ageCategory: preparation.categorie_age_prevue,
          weightCategory: preparation.categorie_poids_prevue,
          participationStatus: null,
          result: EMPTY_RESULT,
        });
      }
    }

    const groups: CoachCompetitionGroupView[] = [...byCompetition.values()].map(({ ref, athletes }) => ({
      competition: ref,
      athleteCount: athletes.size,
      athletes: [...athletes.values()],
    }));

    const upcoming = groups
      .filter((g) => !isPastCompetition(g.competition, now))
      .sort((a, b) => a.competition.startDate.getTime() - b.competition.startDate.getTime());
    // Passées : plus récentes en premier (à l'inverse de "upcoming", trié
    // croissant) — l'échéance la plus proche prime à venir, le résultat le
    // plus récent prime au passé (même intuition produit, ticket §3).
    const past = groups
      .filter((g) => isPastCompetition(g.competition, now))
      .sort((a, b) => b.competition.startDate.getTime() - a.competition.startDate.getTime());

    return { upcoming, past };
  }

  // GET /coach/competitions/:competitionId. Le contrôle d'accès (le coach a
  // au moins un athlète lié par participation OU par préparation interne à
  // cette compétition) est déjà fait par CoachCompetitionOwnershipGuard avant
  // que ce service ne soit appelé — pas revérifié ici. La liste d'athlètes
  // affichée fusionne participation officielle et préparation par athlete.id
  // (ticket §7/§8) : un athlète avec les deux apparaît une seule fois, avec
  // hasOfficialParticipation=true ET preparation renseignée.
  async getCompetitionDetail(coachId: string, competitionId: string): Promise<CoachCompetitionDetailView> {
    const athleteById = await this.resolveRosterBase(coachId);
    const athleteIds = [...athleteById.keys()];

    const [participations, preparations] = await Promise.all([
      this.repository.findParticipationsForAthletesAndCompetition(athleteIds, competitionId),
      this.preparationsRepository.findForCompetition(coachId, competitionId),
    ]);

    let competitionRef: CoachCompetitionRef | null =
      participations.length > 0 ? toCompetitionRefFromParticipation(participations[0]) : null;

    const athletes = new Map<string, CoachCompetitionDetailAthleteView>();

    for (const participation of participations) {
      const athlete = athleteById.get(participation.athlete_id);
      if (!athlete) continue;
      athletes.set(athlete.id, {
        id: athlete.id,
        firstName: athlete.firstName,
        lastName: athlete.lastName,
        ageCategory: participation.categorie_age,
        weightCategory: participation.categorie_poids,
        participationStatus: participation.statut,
        result: toResultView(participation),
        hasOfficialParticipation: true,
        groups: [],
        preparation: null,
      });
    }

    for (const preparation of preparations) {
      const athlete = athleteById.get(preparation.athlete_id);
      if (!athlete) continue; // §31, voir getCompetitions.

      const existing = athletes.get(athlete.id);
      if (existing) {
        existing.preparation = toPreparationSummary(preparation);
        continue;
      }

      athletes.set(athlete.id, {
        id: athlete.id,
        firstName: athlete.firstName,
        lastName: athlete.lastName,
        ageCategory: preparation.categorie_age_prevue,
        weightCategory: preparation.categorie_poids_prevue,
        participationStatus: null,
        result: EMPTY_RESULT,
        hasOfficialParticipation: false,
        groups: [],
        preparation: toPreparationSummary(preparation),
      });
    }

    // Hero indépendant des participations actives trouvées (voir
    // findCompetitionRef) : si le seul lien du coach est une préparation, ou
    // si la seule participation active a disparu (retrait), la page doit
    // quand même pouvoir afficher QUELLE compétition c'est.
    if (!competitionRef) {
      const competition = await this.repository.findCompetitionRef(competitionId);
      if (!competition) {
        throw new NotFoundException("Compétition introuvable");
      }
      competitionRef = {
        id: competition.id,
        name: competition.nom,
        startDate: competition.date_debut,
        endDate: competition.date_fin,
        city: competition.ville,
        country: competition.pays,
        level: competition.niveau,
      };
    }

    if (athletes.size === 0) {
      return { competition: competitionRef, athleteCount: 0, athletes: [] };
    }

    const groupLinks = await this.repository.findGroupsForAthletes([...athletes.keys()], coachId);
    const groupsByAthleteId = new Map<string, { id: string; name: string }[]>();
    for (const link of groupLinks) {
      const list = groupsByAthleteId.get(link.athlete_id) ?? [];
      list.push({ id: link.coach_group.id, name: link.coach_group.name });
      groupsByAthleteId.set(link.athlete_id, list);
    }

    const finalAthletes = [...athletes.values()].map((athlete) => ({
      ...athlete,
      groups: groupsByAthleteId.get(athlete.id) ?? [],
    }));

    return { competition: competitionRef, athleteCount: finalAthletes.length, athletes: finalAthletes };
  }
}
