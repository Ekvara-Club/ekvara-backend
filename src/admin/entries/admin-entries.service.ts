import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { competition_entry as EntryModel, Prisma } from "../../../generated/prisma/client";
import { AdminAuditLogger } from "../admin-audit.logger";
import { MANUAL_SOURCE } from "../competitions/admin-competition-origin";
import { nameTokens } from "../athletes/admin-athlete-rules";
import { detectDuplicateEntries, EntryDuplicateCandidate, entryOrigin, ExistingEntry, normalizeLabel } from "./admin-entry-rules";
import { AdminEntriesRepository, EntryData } from "./admin-entries.repository";
import { AdminEntryBulkDto } from "./dto/admin-entry-bulk.dto";
import { AdminEntryDto } from "./dto/admin-entry.dto";

export const ENTRY_DUPLICATES_MESSAGE = "Participant(s) potentiellement identique(s) : vérifiez-les et confirmez explicitement avant d'enregistrer";
export const ENTRY_EXISTS_MESSAGE = "Ce participant est déjà inscrit manuellement dans cette catégorie";
export const BULK_BLOCKED_MESSAGE = "Certaines lignes ne peuvent pas être enregistrées : retirez-les ou corrigez-les, aucun participant n'a été ajouté";
export const BULK_TWIN_MESSAGE = "Même participant (nom et catégorie) déjà présent plus haut dans la liste";
export const IMPORTED_ENTRY_MESSAGE = "Participant importé : ses informations sont maintenues par la source et ne sont pas modifiables";

@Injectable()
export class AdminEntriesService {
  constructor(
    private readonly repository: AdminEntriesRepository,
    private readonly audit: AdminAuditLogger,
  ) {}

  async list(competitionId: string) {
    await this.assertCompetition(competitionId);
    const entries = await this.repository.listByCompetition(competitionId);
    return { competitionId, total: entries.length, items: entries.map(toEntryView) };
  }

  // Prévisualisation : validation + doublons, AUCUNE écriture.
  async previewCreate(competitionId: string, dto: AdminEntryDto) {
    await this.assertCompetition(competitionId);
    const data = toEntryData(dto);
    return { data: toFieldsView(data), ...(await this.analyse(competitionId, data)), warnings: warningsFor(data) };
  }

  async create(competitionId: string, dto: AdminEntryDto, adminUserId: string) {
    await this.assertCompetition(competitionId);
    const data = toEntryData(dto);
    this.assertWritable(await this.analyse(competitionId, data), dto.acknowledgedDuplicateIds);
    let created: EntryModel;
    try {
      created = await this.repository.create(competitionId, data);
    } catch (error) {
      // Filet : contrainte unique (compétition, source, nom, catégorie).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException(ENTRY_EXISTS_MESSAGE);
      throw error;
    }
    this.audit.record("admin.entry.created", { userId: adminUserId, competitionId, entryId: created.id });
    return toEntryView(created);
  }

  // Lot — prévisualisation : statut de chaque ligne, AUCUNE écriture.
  async previewBulk(competitionId: string, dto: AdminEntryBulkDto) {
    await this.assertCompetition(competitionId);
    const lines = await this.analyseBulk(competitionId, dto.entries);
    return {
      competitionId,
      total: lines.length,
      ready: lines.filter((l) => !l.blocking && l.candidates.length === 0).length,
      needsConfirmation: lines.filter((l) => !l.blocking && l.candidates.length > 0).length,
      blocked: lines.filter((l) => l.blocking).length,
      lines: lines.map(toBulkLineView),
    };
  }

  // Lot — enregistrement TOUT OU RIEN : la moindre ligne bloquée ou non
  // confirmée refuse le lot entier (409, lignes concernées détaillées) ;
  // sinon une seule transaction crée toutes les lignes.
  async createBulk(competitionId: string, dto: AdminEntryBulkDto, adminUserId: string) {
    await this.assertCompetition(competitionId);
    const lines = await this.analyseBulk(competitionId, dto.entries);
    const blocked = lines.filter((l) => l.blocking);
    if (blocked.length > 0) {
      throw new ConflictException({ statusCode: 409, message: BULK_BLOCKED_MESSAGE, blocking: true, lines: blocked.map(toBulkLineView) });
    }
    const pending = lines.filter(unconfirmed);
    if (pending.length > 0) {
      throw new ConflictException({ statusCode: 409, message: ENTRY_DUPLICATES_MESSAGE, lines: pending.map(toBulkLineView) });
    }
    let created: EntryModel[];
    try {
      created = await this.repository.createMany(competitionId, lines.map((l) => l.data));
    } catch (error) {
      // Filet (écriture concurrente) : la transaction est annulée en entier.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException(ENTRY_EXISTS_MESSAGE);
      throw error;
    }
    this.audit.record("admin.entry.bulk_created", { userId: adminUserId, competitionId, count: created.length, entryIds: created.map((e) => e.id) });
    return { competitionId, total: created.length, items: created.map(toEntryView) };
  }

  async previewUpdate(id: string, dto: AdminEntryDto) {
    const current = await this.manualEntry(id);
    const data = toEntryData(dto);
    return {
      data: toFieldsView(data),
      changedFields: changedFields(current, data),
      ...(await this.analyse(current.competition_id, data, id)),
      warnings: warningsFor(data),
    };
  }

  async update(id: string, dto: AdminEntryDto, adminUserId: string) {
    const current = await this.manualEntry(id);
    const data = toEntryData(dto);
    const fields = changedFields(current, data);
    if (fields.length === 0) return toEntryView(current);
    this.assertWritable(await this.analyse(current.competition_id, data, id), dto.acknowledgedDuplicateIds);
    try {
      if (!(await this.repository.updateManual(id, data))) throw new ForbiddenException(IMPORTED_ENTRY_MESSAGE);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException(ENTRY_EXISTS_MESSAGE);
      throw error;
    }
    this.audit.record("admin.entry.updated", { userId: adminUserId, entryId: id, fields });
    return toEntryView((await this.repository.findById(id))!);
  }

  private async manualEntry(id: string): Promise<EntryModel> {
    const entry = await this.repository.findById(id);
    if (!entry) throw new NotFoundException("Participant introuvable");
    if (entryOrigin(entry.source) !== "manual") throw new ForbiddenException(IMPORTED_ENTRY_MESSAGE);
    return entry;
  }

  private async analyse(competitionId: string, data: EntryData, excludeId?: string) {
    return analyseAgainst(await this.repository.findForDuplicates(competitionId, excludeId), data);
  }

  // Lot : chaque ligne est analysée comme une saisie unitaire contre les
  // inscrits existants (une seule lecture), plus contre les lignes
  // PRÉCÉDENTES du lot : même nom et même catégorie -> ligne bloquée (même
  // participant deux fois dans la liste).
  private async analyseBulk(competitionId: string, dtos: AdminEntryDto[]): Promise<BulkLine[]> {
    const existing = await this.repository.findForDuplicates(competitionId);
    const seen: { name: string; category: string; index: number }[] = [];
    return dtos.map((dto, index) => {
      const data = toEntryData(dto);
      const own = analyseAgainst(existing, data);
      const key = { name: nameTokens(data.participant_name).join(" "), category: normalizeLabel(data.source_category_raw_label) };
      const twin = key.name ? seen.find((s) => s.name === key.name && s.category === key.category) : undefined;
      seen.push({ ...key, index });
      const blocking = own.blocking ?? (twin ? bulkTwinMessage(twin.index) : null);
      return { index, data, blocking, candidates: own.candidates, acknowledged: dto.acknowledgedDuplicateIds };
    });
  }

  private assertWritable(analysis: { blocking: string | null; candidates: EntryDuplicateCandidate[] }, acknowledged: string[] | undefined) {
    if (analysis.blocking) throw new ConflictException({ statusCode: 409, message: analysis.blocking, blocking: true, candidates: analysis.candidates });
    const ack = new Set(acknowledged ?? []);
    if (analysis.candidates.some((c) => !ack.has(c.id))) {
      throw new ConflictException({ statusCode: 409, message: ENTRY_DUPLICATES_MESSAGE, candidates: analysis.candidates });
    }
  }

  private async assertCompetition(competitionId: string) {
    if ((await this.repository.competitionExists(competitionId)) === 0) throw new NotFoundException("Compétition introuvable");
  }
}

interface BulkLine {
  index: number;
  data: EntryData;
  blocking: string | null;
  candidates: EntryDuplicateCandidate[];
  acknowledged: string[] | undefined;
}

// blocking : doublon EXACT d'un participant manuel (même nom, même
// catégorie) — interdit par la contrainte unique, jamais "confirmable".
function analyseAgainst(existing: ExistingEntry[], data: EntryData) {
  const exact = existing.some(
    (e) => e.source === MANUAL_SOURCE && e.participant_name === data.participant_name && e.source_category_raw_label === data.source_category_raw_label,
  );
  const candidates = detectDuplicateEntries({ participantName: data.participant_name, category: data.source_category_raw_label }, existing);
  return { blocking: exact ? ENTRY_EXISTS_MESSAGE : null, candidates };
}

function bulkTwinMessage(index: number): string {
  return `${BULK_TWIN_MESSAGE} (ligne ${index + 1})`;
}

function unconfirmed(line: BulkLine): boolean {
  const ack = new Set(line.acknowledged ?? []);
  return line.candidates.some((c) => !ack.has(c.id));
}

// index : position dans le lot envoyé (0 = première ligne).
function toBulkLineView(line: BulkLine) {
  return { index: line.index, data: toFieldsView(line.data), blocking: line.blocking, candidates: line.candidates, warnings: warningsFor(line.data) };
}

function toEntryData(dto: AdminEntryDto): EntryData {
  return {
    participant_name: dto.participantName,
    source_category_raw_label: dto.category,
    age_category: dto.ageCategory ?? null,
    gender: dto.gender ?? null,
    weight_category: dto.weightCategory ?? null,
    club: dto.club ?? null,
    country: dto.country ?? null,
  };
}

const FIELD_COLUMNS: Record<string, keyof EntryData> = {
  participantName: "participant_name",
  category: "source_category_raw_label",
  ageCategory: "age_category",
  gender: "gender",
  weightCategory: "weight_category",
  club: "club",
  country: "country",
};

function changedFields(current: EntryModel, next: EntryData): string[] {
  return Object.entries(FIELD_COLUMNS)
    .filter(([, column]) => current[column] !== next[column])
    .map(([field]) => field);
}

function warningsFor(data: EntryData): string[] {
  const warnings: string[] = [];
  if (!data.country) warnings.push("Pays non renseigné.");
  if (!data.club) warnings.push("Club non renseigné.");
  return warnings;
}

function toFieldsView(data: EntryData) {
  return {
    participantName: data.participant_name,
    category: data.source_category_raw_label,
    ageCategory: data.age_category,
    gender: data.gender,
    weightCategory: data.weight_category,
    club: data.club,
    country: data.country,
  };
}

function toEntryView(entry: EntryModel) {
  return {
    id: entry.id,
    competitionId: entry.competition_id,
    ...toFieldsView(entry),
    league: entry.league,
    source: entry.source,
    origin: entryOrigin(entry.source),
    createdAt: entry.created_at?.toISOString() ?? null,
  };
}
