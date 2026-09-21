import { Injectable, NotFoundException } from "@nestjs/common";
import { external_athlete as ExternalAthleteModel } from "../../generated/prisma/client";
import { AthleteWithSources, InternationalRepository, MatchWithRelations } from "./international.repository";

@Injectable()
export class InternationalService {
  constructor(private readonly repository: InternationalRepository) {}

  async getAthlete(id: string) {
    const athlete = await this.repository.findAthleteById(id);
    if (!athlete) {
      throw new NotFoundException(`Athlète international ${id} introuvable`);
    }
    return toAthleteView(athlete);
  }

  async getAthleteMatches(id: string, page: number, limit: number) {
    if (!(await this.repository.findAthleteById(id))) {
      throw new NotFoundException(`Athlète international ${id} introuvable`);
    }
    const result = await this.repository.findMatchesByAthlete(id, page, limit);
    return { ...result, items: result.items.map(toMatchView) };
  }

  async getCompetitionMatches(competitionId: string, page: number, limit: number) {
    if (!(await this.repository.competitionExists(competitionId))) {
      throw new NotFoundException(`Competition ${competitionId} introuvable`);
    }
    const result = await this.repository.findMatchesByCompetition(competitionId, page, limit);
    return { ...result, items: result.items.map(toMatchView) };
  }
}

// Vue stable : jamais l'objet Prisma brut (created_at/updated_at internes).
//
// stats.sourceRecord : record V/D AFFICHÉ par la source avec sa provenance et sa
// date de relevé — jamais un record recalculé à partir de nos matchs (jeu
// partiel : un faux 3-1 sur 4 combats importés serait trompeur). null tant
// qu'aucun profil source n'a été relevé.
export function toAthleteView(athlete: AthleteWithSources) {
  const withImage = athlete.sources.find((s) => s.image_url !== null);
  const withRecord = athlete.sources.find((s) => s.record_wins !== null && s.record_losses !== null);

  return {
    id: athlete.id,
    displayName: athlete.display_name,
    countryCode: athlete.country_code,
    imageUrl: withImage?.image_url ?? null,
    sources: athlete.sources.map((s) => ({
      source: s.source,
      externalId: s.source_external_id,
      sourceUrl: s.source_url,
    })),
    stats: {
      sourceRecord: withRecord
        ? {
            wins: withRecord.record_wins,
            losses: withRecord.record_losses,
            source: withRecord.source,
            syncedAt: withRecord.record_synced_at,
          }
        : null,
    },
  };
}

function toAthleteSummary(athlete: ExternalAthleteModel) {
  return { id: athlete.id, displayName: athlete.display_name, countryCode: athlete.country_code };
}

// scoreA/scoreB suivent l'ordre athleteA/athleteB tel que lu sur la page match
// de la source ; winner vient du marqueur de la source (jamais scoreA > scoreB).
// stage = tour du tableau (F, SF, QF, R16...), à ne pas confondre avec les
// rounds R1/R2/R3 d'un combat, non exposés en V1.
export function toMatchView(match: MatchWithRelations) {
  return {
    id: match.id,
    competition: {
      id: match.competition.id,
      name: match.competition.nom,
      dateDebut: match.competition.date_debut,
      dateFin: match.competition.date_fin,
    },
    category: match.category_label,
    stage: match.bracket_stage,
    contestNumber: match.contest_number,
    athleteA: toAthleteSummary(match.athlete_a),
    athleteB: toAthleteSummary(match.athlete_b),
    scoreA: match.score_a,
    scoreB: match.score_b,
    winner: match.winner ? toAthleteSummary(match.winner) : null,
    method: match.result_method,
    // Représentation retenue à la création (comportement historique inchangé).
    source: { source: match.source, externalId: match.source_external_id, sourceUrl: match.source_url },
    // TOUTES les représentations source du même combat (WT Results en publie
    // parfois plusieurs pour un combat réel) : provenance complète, jamais
    // dupliquée en autant de combats.
    sources: match.sources.map((s) => ({ source: s.source, externalId: s.source_external_id, sourceUrl: s.source_url })),
  };
}
