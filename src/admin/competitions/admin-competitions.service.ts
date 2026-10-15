import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { CompetitionsRepository } from "../../competitions/competitions.repository";
import { AdminAuditLogger } from "../admin-audit.logger";
import { DuplicateCandidate, detectDuplicateCompetitions } from "./admin-competition-duplicates";
import { CompetitionField, CompetitionOrigin, competitionOrigin, EDITABLE_FIELDS } from "./admin-competition-origin";
import { AdminCompetitionsRepository, CompetitionData, CompetitionListRow, CompetitionNoLongerManualError } from "./admin-competitions.repository";
import { AdminCompetitionCreateDto, AdminCompetitionListQueryDto, AdminCompetitionUpdateDto } from "./dto/admin-competition.dto";

// Bornes identiques à l'import World Taekwondo (CompetitionsController).
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const DTO_TO_COLUMN: Record<CompetitionField, keyof CompetitionData> = {
  nom: "nom",
  organisateur: "organisateur",
  dateDebut: "date_debut",
  dateFin: "date_fin",
  lieu: "lieu",
  ville: "ville",
  pays: "pays",
  niveau: "niveau",
  saison: "saison",
};
const FIELDS = Object.keys(DTO_TO_COLUMN) as CompetitionField[];
// Champs qui interviennent dans la détection de doublons.
const IDENTITY_FIELDS: CompetitionField[] = ["nom", "dateDebut", "ville"];

export const DUPLICATES_NOT_ACKNOWLEDGED_MESSAGE =
  "Compétition(s) potentiellement identique(s) : vérifiez-les et confirmez explicitement avant d'enregistrer";
export const IMPORTED_READ_ONLY_MESSAGE =
  "Compétition importée : seule la saison est modifiable (les autres champs sont gérés par la synchronisation des sources)";

type CompetitionDetail = NonNullable<Awaited<ReturnType<CompetitionsRepository["findById"]>>>;

@Injectable()
export class AdminCompetitionsService {
  constructor(
    private readonly repository: AdminCompetitionsRepository,
    private readonly competitionsRepository: CompetitionsRepository,
    private readonly audit: AdminAuditLogger,
  ) {}

  async list(query: AdminCompetitionListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const { rows, total } = await this.repository.list({
      search: query.search || undefined,
      year: query.year,
      page,
      limit,
      sort: query.sort ?? "desc",
      origin: query.origin ?? "all",
    });
    return { items: rows.map(toListItem), total, page, limit };
  }

  async years() {
    return { years: await this.competitionsRepository.listYears() };
  }

  async getDetail(id: string) {
    const competition = await this.competitionsRepository.findById(id);
    if (!competition) throw new NotFoundException("Compétition introuvable");
    return toDetailView(competition);
  }

  // Prévisualisation : validations + doublons, AUCUNE écriture.
  async previewCreate(dto: AdminCompetitionCreateDto) {
    const data = toCompetitionData(dto);
    const candidates = await this.duplicatesFor(data);
    return { data: toFieldsView(data), candidates, warnings: warningsFor(data) };
  }

  async create(dto: AdminCompetitionCreateDto, adminUserId: string) {
    const data = toCompetitionData(dto);
    // Recalculé au moment de l'écriture : jamais de confiance dans le
    // résultat d'une prévisualisation antérieure.
    const candidates = await this.duplicatesFor(data);
    assertAcknowledged(candidates, dto.acknowledgedDuplicateIds);

    const created = await this.repository.createManual(data);
    this.audit.record("admin.competition.created", {
      userId: adminUserId,
      competitionId: created.id,
      acknowledgedDuplicateIds: candidates.map((c) => c.id),
    });
    return this.getDetail(created.id);
  }

  async previewUpdate(id: string, dto: AdminCompetitionUpdateDto) {
    const plan = await this.planUpdate(id, dto);
    const candidates = plan.identityChanged ? await this.duplicatesFor(plan.next, id) : [];
    return { data: toFieldsView(plan.next), changedFields: plan.changedFields, candidates, warnings: warningsFor(plan.next) };
  }

  async update(id: string, dto: AdminCompetitionUpdateDto, adminUserId: string) {
    const plan = await this.planUpdate(id, dto);
    if (plan.changedFields.length === 0) return toDetailView(plan.current);

    if (plan.origin === "imported") {
      await this.repository.updateSaison(id, plan.next.saison);
    } else {
      if (plan.identityChanged) {
        assertAcknowledged(await this.duplicatesFor(plan.next, id), dto.acknowledgedDuplicateIds);
      }
      try {
        await this.repository.updateManual(id, plan.next);
      } catch (error) {
        if (error instanceof CompetitionNoLongerManualError) throw new ForbiddenException(IMPORTED_READ_ONLY_MESSAGE);
        throw error;
      }
    }

    this.audit.record("admin.competition.updated", {
      userId: adminUserId,
      competitionId: id,
      origin: plan.origin,
      fields: plan.changedFields,
    });
    return this.getDetail(id);
  }

  // Lecture + règles d'origine + fusion + validation métier, sans écriture.
  private async planUpdate(id: string, dto: AdminCompetitionUpdateDto) {
    const current = await this.competitionsRepository.findById(id);
    if (!current) throw new NotFoundException("Compétition introuvable");
    const origin: CompetitionOrigin = competitionOrigin(current.all_sources);

    const provided = FIELDS.filter((field) => dto[field] !== undefined);
    const forbidden = provided.filter((field) => !EDITABLE_FIELDS[origin].includes(field));
    if (forbidden.length > 0) throw new ForbiddenException(IMPORTED_READ_ONLY_MESSAGE);

    const next: CompetitionData = { ...columnsOf(current) };
    for (const field of provided) {
      if (field === "dateDebut") next.date_debut = parseDay(dto.dateDebut!, "La date de début");
      else if (field === "dateFin") next.date_fin = dto.dateFin ? parseDay(dto.dateFin, "La date de fin") : null;
      else (next as unknown as Record<string, string | null>)[DTO_TO_COLUMN[field]] = dto[field] as string | null;
    }
    assertDateRange(next);

    const before = columnsOf(current);
    const changedFields = FIELDS.filter((field) => !sameValue(before[DTO_TO_COLUMN[field]], next[DTO_TO_COLUMN[field]]));
    return { current, origin, next, changedFields, identityChanged: changedFields.some((f) => IDENTITY_FIELDS.includes(f)) };
  }

  private async duplicatesFor(data: CompetitionData, excludeId?: string): Promise<DuplicateCandidate[]> {
    const existing = await this.repository.findDuplicateCandidates(data.date_debut, excludeId);
    return detectDuplicateCompetitions(
      {
        nom: data.nom,
        dateDebut: data.date_debut,
        dateFin: data.date_fin,
        lieu: data.lieu,
        ville: data.ville,
        pays: data.pays,
        organisateur: data.organisateur,
        niveau: data.niveau,
      },
      existing,
    );
  }
}

// Toute correspondance doit avoir été explicitement confirmée ; sinon 409
// avec les candidates, rien n'est écrit. Jamais de fusion automatique.
function assertAcknowledged(candidates: DuplicateCandidate[], acknowledged: string[] | undefined): void {
  const ack = new Set(acknowledged ?? []);
  const missing = candidates.filter((c) => !ack.has(c.id));
  if (missing.length > 0) {
    throw new ConflictException({ statusCode: 409, message: DUPLICATES_NOT_ACKNOWLEDGED_MESSAGE, candidates });
  }
}

function toCompetitionData(dto: AdminCompetitionCreateDto): CompetitionData {
  const data: CompetitionData = {
    nom: dto.nom,
    organisateur: dto.organisateur ?? null,
    date_debut: parseDay(dto.dateDebut, "La date de début"),
    date_fin: dto.dateFin ? parseDay(dto.dateFin, "La date de fin") : null,
    lieu: dto.lieu ?? null,
    ville: dto.ville ?? null,
    pays: dto.pays ?? null,
    niveau: dto.niveau ?? null,
    saison: dto.saison ?? null,
  };
  assertDateRange(data);
  return data;
}

// AAAA-MM-JJ déjà garanti par le DTO : vérifie que le jour existe réellement
// (pas de 2026-02-30 silencieusement décalé) et les bornes.
function parseDay(value: string, label: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${label} n'est pas une date valide`);
  }
  const year = date.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new BadRequestException(`${label} doit être comprise entre ${MIN_YEAR} et ${MAX_YEAR}`);
  }
  return date;
}

function assertDateRange(data: CompetitionData): void {
  if (data.date_fin && data.date_fin.getTime() < data.date_debut.getTime()) {
    throw new BadRequestException("La date de fin ne peut pas précéder la date de début");
  }
}

function warningsFor(data: CompetitionData): string[] {
  const warnings: string[] = [];
  if (!data.date_fin) warnings.push("Date de fin non renseignée.");
  if (!data.ville) warnings.push("Ville non renseignée.");
  if (!data.pays) warnings.push("Pays non renseigné.");
  return warnings;
}

function columnsOf(c: CompetitionDetail): CompetitionData {
  return {
    nom: c.nom,
    organisateur: c.organisateur,
    date_debut: c.date_debut,
    date_fin: c.date_fin,
    lieu: c.lieu,
    ville: c.ville,
    pays: c.pays,
    niveau: c.niveau,
    saison: c.saison,
  };
}

function sameValue(a: string | Date | null, b: string | Date | null): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return a === b;
}

function day(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function toFieldsView(data: CompetitionData) {
  return {
    nom: data.nom,
    organisateur: data.organisateur,
    dateDebut: day(data.date_debut)!,
    dateFin: day(data.date_fin),
    lieu: data.lieu,
    ville: data.ville,
    pays: data.pays,
    niveau: data.niveau,
    saison: data.saison,
  };
}

function toListItem(row: CompetitionListRow) {
  return {
    id: row.id,
    nom: row.nom,
    dateDebut: day(row.date_debut)!,
    dateFin: day(row.date_fin),
    ville: row.ville,
    pays: row.pays,
    niveau: row.niveau,
    saison: row.saison,
    origin: competitionOrigin(row.sources),
    sources: [...new Set(row.sources.map((s) => s.source))],
    matchCount: row._count.matches,
    entryCount: row._count.entries,
  };
}

function toDetailView(c: CompetitionDetail) {
  const origin = competitionOrigin(c.all_sources);
  return {
    id: c.id,
    ...toFieldsView(columnsOf(c)),
    origin,
    editableFields: EDITABLE_FIELDS[origin],
    sources: c.all_sources.map((s) => ({ source: s.source, sourceUrl: s.source_url })),
    counts: c.counts,
    createdAt: c.created_at?.toISOString() ?? null,
    updatedAt: c.updated_at?.toISOString() ?? null,
  };
}
