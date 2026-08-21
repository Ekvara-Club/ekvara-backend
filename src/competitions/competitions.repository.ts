import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { competition as CompetitionModel } from "../../generated/prisma/client";
import { ImportedCompetition } from "./importers/imported-competition.interface";
import { matchCompetitions } from "./matching/competition-matcher";

// Résultat de la logique de dédoublonnage multi-source (voir
// src/competitions/matching/competition-matcher.ts et le rapport du ticket
// "Migration réelle vers competition canonique + competition_source") :
// - "updated" : la source était déjà connue (source, source_external_id), la
//   competition canonique associée a été retrouvée ;
// - "attachedSafe" : source jamais vue, mais rattachée automatiquement à une
//   competition canonique existante car matchCompetitions() a renvoyé
//   exactement un SAFE ;
// - "created" : source jamais vue, aucun SAFE unique trouvé (aucun match,
//   AMBIGUOUS, ou plusieurs SAFE en même temps — jamais résolu
//   automatiquement, voir §6/§5 du ticket) ⇒ nouvelle competition canonique.
export type UpsertOutcome = "updated" | "attachedSafe" | "created";

export interface UpsertResult {
  competition: CompetitionModel;
  created: boolean;
  outcome: UpsertOutcome;
}

@Injectable()
export class CompetitionsRepository {
  private readonly logger = new Logger(CompetitionsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // Compatibilité frontend (GET /competitions renvoie encore source/
  // source_external_id à plat, voir CompetitionCatalogItem côté frontend) :
  // competition n'a plus ces colonnes nativement, donc on les dérive de la
  // "source primaire" — la toute première competition_source créée pour
  // cette competition (created_at le plus ancien). Pour les 122 competitions
  // historiques (une seule source chacune), c'est exactement la même valeur
  // qu'avant la migration. Pour une competition dédoublonnée, c'est la
  // source qui a créé la ligne canonique à l'origine.
  async findMany() {
    const competitions = await this.prisma.competition.findMany({
      orderBy: { date_debut: "desc" },
      include: { sources: { orderBy: { created_at: "asc" }, take: 1 } },
    });
    return competitions.map(withPrimarySourceFlat);
  }

  async findById(id: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id },
      include: { sources: { orderBy: { created_at: "asc" }, take: 1 } },
    });
    return competition ? withPrimarySourceFlat(competition) : null;
  }

  async upsertFromSource(data: ImportedCompetition): Promise<UpsertResult> {
    const existingSource = await this.prisma.competition_source.findUnique({
      where: {
        source_source_external_id: {
          source: data.source,
          source_external_id: data.sourceExternalId,
        },
      },
    });

    // Étape A — source déjà connue : ré-import idempotent de cette source.
    if (existingSource) {
      await this.prisma.competition_source.update({
        where: { id: existingSource.id },
        data: rawSourcePayload(data),
      });
      const competition = await this.fillNullFieldsOnly(existingSource.competition_id, data);
      return { competition, created: false, outcome: "updated" };
    }

    // Étape B — source inconnue : chercher des candidates par date_debut
    // exacte (seul critère jamais suffisant seul dans matchCompetitions,
    // mais un pré-filtre nécessaire — pas question de comparer contre les
    // 122+ competitions existantes à chaque import).
    const candidates = await this.prisma.competition.findMany({
      where: { date_debut: data.dateDebut },
    });

    const safeMatches = candidates.filter(
      (candidate) => matchCompetitions(toImportedCompetition(candidate), data).confidence === "SAFE",
    );

    if (safeMatches.length === 1) {
      const target = safeMatches[0];
      await this.prisma.competition_source.create({
        data: {
          competition_id: target.id,
          source: data.source,
          source_external_id: data.sourceExternalId,
          match_confidence: "safe",
          ...rawSourcePayload(data),
        },
      });
      const competition = await this.fillNullFieldsOnly(target.id, data);
      this.logger.log(
        `Rattachement automatique (SAFE) : ${data.source}/${data.sourceExternalId} ("${data.nom}") → competition existante ${target.id} ("${target.nom}")`,
      );
      return { competition, created: false, outcome: "attachedSafe" };
    }

    if (safeMatches.length > 1) {
      // Sécurité explicite (§6 du ticket) : plusieurs competitions SAFE pour
      // la même source entrante = ambiguïté dans les DONNÉES existantes
      // elles-mêmes (ne devrait normalement pas arriver). On ne choisit
      // jamais automatiquement laquelle fusionner : nouvelle competition
      // distincte + log explicite pour revue manuelle ultérieure. Préserve
      // la non-destruction plutôt qu'un choix arbitraire.
      this.logger.warn(
        `Plusieurs competitions SAFE trouvées pour ${data.source}/${data.sourceExternalId} ("${data.nom}") : [${safeMatches.map((c) => c.id).join(", ")}] — création d'une nouvelle competition distincte plutôt qu'une fusion automatique incertaine.`,
      );
    }

    // AMBIGUOUS, DIFFERENT, ou plusieurs SAFE : jamais de fusion automatique.
    // Pour le MVP, traité uniformément comme une nouvelle competition
    // distincte (choix documenté au rapport : plus sûr qu'un rattachement
    // incertain, et n'importe quelle AMBIGUOUS reste visible/consultable en
    // base pour un rapprochement manuel futur via competition_source).
    const competition = await this.prisma.competition.create({
      data: {
        nom: data.nom,
        date_debut: data.dateDebut,
        date_fin: data.dateFin,
        lieu: data.lieu,
        ville: data.ville,
        pays: data.pays,
        organisateur: data.organisateur,
        niveau: data.niveau,
        sources: {
          create: {
            source: data.source,
            source_external_id: data.sourceExternalId,
            match_confidence: null,
            ...rawSourcePayload(data),
          },
        },
      },
    });
    return { competition, created: true, outcome: "created" };
  }

  // Politique de fusion des champs (§7 du ticket) : une source ne peut
  // JAMAIS écraser un champ canonique déjà renseigné — elle ne peut que
  // combler un champ actuellement null. Simple, déterministe, sans table de
  // priorité par champ par source.
  private async fillNullFieldsOnly(competitionId: string, data: ImportedCompetition): Promise<CompetitionModel> {
    const current = await this.prisma.competition.findUniqueOrThrow({ where: { id: competitionId } });

    const patch: Record<string, unknown> = {};
    if (current.organisateur === null && data.organisateur) patch.organisateur = data.organisateur;
    if (current.lieu === null && data.lieu) patch.lieu = data.lieu;
    if (current.ville === null && data.ville) patch.ville = data.ville;
    if (current.pays === null && data.pays) patch.pays = data.pays;
    if (current.niveau === null && data.niveau) patch.niveau = data.niveau;
    if (current.date_fin === null && data.dateFin) patch.date_fin = data.dateFin;

    if (Object.keys(patch).length === 0) {
      return current;
    }

    return this.prisma.competition.update({ where: { id: competitionId }, data: patch });
  }
}

function withPrimarySourceFlat<
  T extends CompetitionModel & { sources: { source: string; source_external_id: string }[] },
>(competition: T): CompetitionModel & { source: string | null; source_external_id: string | null } {
  const { sources, ...rest } = competition;
  const primary = sources[0];
  return { ...rest, source: primary?.source ?? null, source_external_id: primary?.source_external_id ?? null };
}

function rawSourcePayload(data: ImportedCompetition) {
  return {
    raw_nom: data.nom,
    raw_organisateur: data.organisateur ?? null,
    raw_lieu: data.lieu ?? null,
    raw_ville: data.ville ?? null,
    raw_pays: data.pays ?? null,
    raw_niveau: data.niveau ?? null,
  };
}

// Reconstruit un objet au format ImportedCompetition à partir d'une
// competition canonique déjà en base, pour pouvoir la comparer avec le
// matcher pur (qui ne connaît que ce format). source/sourceExternalId ne
// sont jamais utilisés par matchCompetitions() — placeholders sans effet.
function toImportedCompetition(c: CompetitionModel): ImportedCompetition {
  return {
    source: "__canonical__",
    sourceExternalId: c.id,
    nom: c.nom,
    dateDebut: c.date_debut,
    dateFin: c.date_fin ?? undefined,
    lieu: c.lieu ?? undefined,
    ville: c.ville ?? undefined,
    pays: c.pays ?? undefined,
    organisateur: c.organisateur ?? undefined,
    niveau: c.niveau ?? undefined,
  };
}
