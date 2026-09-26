import { Injectable, Logger } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { PrismaService } from "../prisma/prisma.service";
import { competition as CompetitionModel, Prisma } from "../../generated/prisma/client";
import { todayUtcMidnight } from "./next-competition";
import { CalendarDivision, ImportedCompetition } from "./importers/imported-competition.interface";
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
  //
  // `search` est un ajout additif (ticket Sélection & préparation V1 §23,
  // "+ Préparer une compétition") : filtre optionnel par nom, insensible à
  // la casse, limité à 20 résultats pour rester utilisable dans un champ de
  // recherche — jamais appliqué quand `search` est omis (comportement
  // historique de cet endpoint entièrement inchangé pour les appelants
  // existants, ex. l'app athlète).
  async findMany(search?: string) {
    const competitions = await this.prisma.competition.findMany({
      where: search ? { nom: { contains: search, mode: "insensitive" } } : undefined,
      orderBy: { date_debut: "desc" },
      include: { sources: { orderBy: { created_at: "asc" }, take: 1 } },
      take: search ? 20 : undefined,
    });
    return competitions.map(withPrimarySourceFlat);
  }

  // Ticket "Compétitions Athlete V2" §8-9 : pagination réelle pour le
  // catalogue explorateur, distincte de findMany() ci-dessus qui reste
  // totalement inchangée pour ses appelants existants (AddCompetitionModal
  // côté Athlete et Coach, "+ Préparer une compétition"). Seule cette
  // nouvelle méthode active la pagination — jamais déclenchée sans page/limit
  // explicites côté contrôleur.
  async findManyPaginated(params: {
    search?: string;
    page: number;
    limit: number;
    scope?: "upcoming" | "past";
    year?: number;
  }) {
    const { search, page, limit, scope, year } = params;

    const and: Prisma.competitionWhereInput[] = [];
    if (search) {
      and.push({
        OR: [
          { nom: { contains: search, mode: "insensitive" } },
          { ville: { contains: search, mode: "insensitive" } },
          { pays: { contains: search, mode: "insensitive" } },
        ],
      });
    }
    if (scope === "upcoming" || scope === "past") {
      // Statut temporel = MÊME règle que la saisie de résultat
      // (ParticipationsService) : date de fin effective = date_fin ??
      // date_debut, comparée au jour courant UTC partagé (todayUtcMidnight,
      // next-competition.ts). Passée ⇔ fin effective strictement avant
      // aujourd'hui ; à venir ⇔ fin effective aujourd'hui ou après — une
      // compétition multi-jours EN COURS reste donc "à venir", jamais "passée".
      // Colonnes DATE : aucune heure, aucun décalage de fuseau.
      const today = todayUtcMidnight();
      const cmp = scope === "upcoming" ? { gte: today } : { lt: today };
      and.push({ OR: [{ date_fin: cmp }, { date_fin: null, date_debut: cmp }] });
    }
    if (year !== undefined) {
      // Année = année de date_debut (date canonique de début de l'événement).
      and.push({ date_debut: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } });
    }
    const where: Prisma.competitionWhereInput = and.length > 0 ? { AND: and } : {};

    // À venir : date_debut ASC (le plus proche d'abord) ; passées : DESC (le
    // plus récent d'abord) ; sans scope : comportement par défaut DESC,
    // identique à findMany() (ticket §9). id en départage : ordre total,
    // pagination stable à date égale.
    const direction = scope === "upcoming" ? ("asc" as const) : ("desc" as const);
    const orderBy = [{ date_debut: direction }, { id: "asc" as const }];

    const [competitions, total] = await Promise.all([
      this.prisma.competition.findMany({
        where,
        orderBy,
        include: { sources: { orderBy: { created_at: "asc" }, take: 1 } },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.competition.count({ where }),
    ]);

    return { items: competitions.map(withPrimarySourceFlat), total, page, limit };
  }

  // Années réellement présentes dans le catalogue (année de date_debut),
  // de la plus récente à la plus ancienne — jamais une liste codée en dur.
  async listYears(): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<{ year: number }[]>`
      SELECT DISTINCT EXTRACT(YEAR FROM date_debut)::int AS year FROM competition ORDER BY year DESC`;
    return rows.map((r) => r.year);
  }

  async findById(id: string) {
    const competition = await this.prisma.competition.findUnique({
      where: { id },
      // Pas de take ici (contrairement à findMany) : une fiche détail n'a
      // besoin que d'UNE competition, jamais de N+1 — récupérer toutes ses
      // sources (au plus 2 aujourd'hui) est sans risque de performance,
      // nécessaire pour la section "Sources des données" (ticket §20).
      // _count (même requête) : jeux de données disponibles pour la fiche
      // (ticket Competition Detail V2) — inscrits publiés et combats logiques
      // (competition_match, jamais leurs représentations source).
      include: { sources: { orderBy: { created_at: "asc" } }, _count: { select: { entries: true, matches: true } } },
    });
    if (!competition) return null;
    const { _count, ...rest } = competition;
    return { ...withPrimarySourceFlatAndAllSources(rest), counts: { entries: _count.entries, matches: _count.matches } };
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

  // #22 — rafraîchissement "divisions seules" : met à jour raw_divisions
  // d'une source DÉJÀ connue et rien d'autre. Ne crée jamais de competition
  // ni de source, ne touche ni aux champs canoniques ni aux autres raw_*.
  // N'écrit pas si la valeur est déjà identique (ré-exécution sans écriture).
  async refreshSourceDivisions(
    source: string,
    sourceExternalId: string,
    divisions: CalendarDivision[],
  ): Promise<"updated" | "unchanged" | "unknownSource"> {
    const existing = await this.prisma.competition_source.findUnique({
      where: { source_source_external_id: { source, source_external_id: sourceExternalId } },
      select: { id: true, raw_divisions: true },
    });
    if (!existing) return "unknownSource";
    if (isDeepStrictEqual(existing.raw_divisions, divisions)) return "unchanged";
    await this.prisma.competition_source.update({
      where: { id: existing.id },
      data: { raw_divisions: divisions as unknown as Prisma.InputJsonValue },
    });
    return "updated";
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

// Fiche détail uniquement (ticket §20) : en plus du couple source/
// source_external_id à plat (compatibilité historique, jamais retiré), expose
// la liste complète des competition_source rattachées — nom de source et
// source_url si connue, jamais l'id technique. `sources` ici est le tableau
// complet (contrairement à withPrimarySourceFlat qui ne regarde que [0]).
function withPrimarySourceFlatAndAllSources<
  T extends CompetitionModel & { sources: { source: string; source_external_id: string; source_url: string | null }[] },
>(
  competition: T,
): CompetitionModel & {
  source: string | null;
  source_external_id: string | null;
  all_sources: { source: string; source_url: string | null }[];
} {
  const { sources, ...rest } = competition;
  const primary = sources[0];
  return {
    ...rest,
    source: primary?.source ?? null,
    source_external_id: primary?.source_external_id ?? null,
    all_sources: sources.map((s) => ({ source: s.source, source_url: s.source_url })),
  };
}

function rawSourcePayload(data: ImportedCompetition) {
  return {
    raw_nom: data.nom,
    raw_organisateur: data.organisateur ?? null,
    raw_lieu: data.lieu ?? null,
    raw_ville: data.ville ?? null,
    raw_pays: data.pays ?? null,
    raw_niveau: data.niveau ?? null,
    // Seul l'importeur calendrier WT fournit des divisions : les autres
    // sources ne touchent jamais la colonne (ni écriture, ni effacement).
    ...(data.divisions ? { raw_divisions: data.divisions as unknown as Prisma.InputJsonValue } : {}),
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
