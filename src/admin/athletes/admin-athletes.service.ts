import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InternationalRepository } from "../../international/international.repository";
import { toAthleteFightView, toAthleteView, toRecordedStats } from "../../international/international.service";
import { AdminAuditLogger } from "../admin-audit.logger";
import {
  AthleteDuplicateCandidate,
  AthleteField,
  AthleteOrigin,
  athleteOrigin,
  detectDuplicateAthletes,
  EDITABLE_ATHLETE_FIELDS,
  nameTokens,
} from "./admin-athlete-rules";
import { AdminAthletesRepository, AthleteData, AthleteListRow, AthleteNoLongerManualError } from "./admin-athletes.repository";
import { AdminAthleteCreateDto, AdminAthleteListQueryDto, AdminAthleteUpdateDto } from "./dto/admin-athlete.dto";

const MIN_BIRTH_DATE = "1900-01-01";
const RECENT_FIGHTS = 10;

const DTO_TO_COLUMN: Record<AthleteField, keyof AthleteData> = {
  displayName: "display_name",
  countryCode: "country_code",
  gender: "gender",
  birthDate: "birth_date",
};
const FIELDS = Object.keys(DTO_TO_COLUMN) as AthleteField[];
// Champs qui interviennent dans la détection de doublons.
const IDENTITY_FIELDS: AthleteField[] = ["displayName", "countryCode", "birthDate"];

export const ATHLETE_DUPLICATES_MESSAGE =
  "Athlète(s) potentiellement identique(s) : vérifiez-les et confirmez explicitement avant d'enregistrer";
export const IMPORTED_ATHLETE_MESSAGE =
  "Athlète importé : seuls le genre et la date de naissance peuvent être renseignés (le nom et le pays restent ceux de la source)";

@Injectable()
export class AdminAthletesService {
  constructor(
    private readonly repository: AdminAthletesRepository,
    private readonly international: InternationalRepository,
    private readonly audit: AdminAuditLogger,
  ) {}

  async list(query: AdminAthleteListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const { rows, total } = await this.repository.list({
      search: query.search || undefined,
      country: query.country || undefined,
      page,
      limit,
      origin: query.origin ?? "all",
    });
    return { items: rows.map(toListItem), total, page, limit };
  }

  async countries() {
    return { countries: await this.repository.listCountries() };
  }

  // Profil : vue publique existante (toAthleteView : identité, sources, record
  // affiché par la source) + bilan recensé dans EKVARA + derniers combats.
  async getProfile(id: string) {
    const athlete = await this.international.findAthleteById(id);
    if (!athlete) throw new NotFoundException("Athlète introuvable");
    const [counts, fights, linkedAccounts] = await Promise.all([
      this.international.countAthleteFights(id),
      this.international.findMatchesByAthlete(id, 1, RECENT_FIGHTS),
      this.repository.countConfirmedAccountLinks(id),
    ]);
    const origin = athleteOrigin(athlete.sources);
    return {
      ...toAthleteView(athlete),
      gender: athlete.gender,
      birthDate: day(athlete.birth_date),
      origin,
      editableFields: EDITABLE_ATHLETE_FIELDS[origin],
      recordedStats: toRecordedStats(counts),
      recentFights: fights.items.map((match) => ({ ...toAthleteFightView(match, id), competitionName: match.competition.nom })),
      fightTotal: fights.total,
      // Nombre de comptes EKVARA dont le lien vers ce profil est confirmé —
      // jamais leur identité (aucune donnée personnelle de compte ici).
      linkedAccounts,
      createdAt: athlete.created_at?.toISOString() ?? null,
    };
  }

  // Prévisualisation : validations + doublons, AUCUNE écriture.
  async previewCreate(dto: AdminAthleteCreateDto) {
    const data = toAthleteData(dto);
    return { data: toFieldsView(data), candidates: await this.duplicatesFor(data), warnings: warningsFor(data) };
  }

  async create(dto: AdminAthleteCreateDto, adminUserId: string) {
    const data = toAthleteData(dto);
    // Recalculé au moment de l'écriture, jamais repris de la prévisualisation.
    const candidates = await this.duplicatesFor(data);
    assertAcknowledged(candidates, dto.acknowledgedDuplicateIds);
    const created = await this.repository.createManual(data);
    this.audit.record("admin.athlete.created", {
      userId: adminUserId,
      athleteId: created.id,
      acknowledgedDuplicateIds: candidates.map((c) => c.id),
    });
    return this.getProfile(created.id);
  }

  async previewUpdate(id: string, dto: AdminAthleteUpdateDto) {
    const plan = await this.planUpdate(id, dto);
    const candidates = plan.identityChanged ? await this.duplicatesFor(plan.next, id) : [];
    return { data: toFieldsView(plan.next), changedFields: plan.changedFields, candidates, warnings: warningsFor(plan.next) };
  }

  async update(id: string, dto: AdminAthleteUpdateDto, adminUserId: string) {
    const plan = await this.planUpdate(id, dto);
    if (plan.changedFields.length === 0) return this.getProfile(id);

    if (plan.origin === "imported") {
      await this.repository.updateEnrichment(id, plan.next);
    } else {
      if (plan.identityChanged) assertAcknowledged(await this.duplicatesFor(plan.next, id), dto.acknowledgedDuplicateIds);
      try {
        await this.repository.updateManual(id, plan.next);
      } catch (error) {
        if (error instanceof AthleteNoLongerManualError) throw new ForbiddenException(IMPORTED_ATHLETE_MESSAGE);
        throw error;
      }
    }
    this.audit.record("admin.athlete.updated", { userId: adminUserId, athleteId: id, origin: plan.origin, fields: plan.changedFields });
    return this.getProfile(id);
  }

  private async planUpdate(id: string, dto: AdminAthleteUpdateDto) {
    const athlete = await this.international.findAthleteById(id);
    if (!athlete) throw new NotFoundException("Athlète introuvable");
    const origin: AthleteOrigin = athleteOrigin(athlete.sources);

    const provided = FIELDS.filter((field) => dto[field] !== undefined);
    if (provided.some((field) => !EDITABLE_ATHLETE_FIELDS[origin].includes(field))) {
      throw new ForbiddenException(IMPORTED_ATHLETE_MESSAGE);
    }

    const current: AthleteData = {
      display_name: athlete.display_name,
      country_code: athlete.country_code,
      gender: athlete.gender,
      birth_date: athlete.birth_date,
    };
    const next: AthleteData = { ...current };
    for (const field of provided) {
      if (field === "birthDate") next.birth_date = dto.birthDate ? parseBirthDate(dto.birthDate) : null;
      else (next as unknown as Record<string, string | null>)[DTO_TO_COLUMN[field]] = dto[field] as string | null;
    }

    const changedFields = FIELDS.filter((field) => !sameValue(current[DTO_TO_COLUMN[field]], next[DTO_TO_COLUMN[field]]));
    return { origin, next, changedFields, identityChanged: changedFields.some((f) => IDENTITY_FIELDS.includes(f)) };
  }

  private async duplicatesFor(data: AthleteData, excludeId?: string): Promise<AthleteDuplicateCandidate[]> {
    const existing = await this.repository.findDuplicateCandidates(nameTokens(data.display_name), excludeId);
    return detectDuplicateAthletes({ displayName: data.display_name, countryCode: data.country_code, birthDate: data.birth_date }, existing);
  }
}

function assertAcknowledged(candidates: AthleteDuplicateCandidate[], acknowledged: string[] | undefined): void {
  const ack = new Set(acknowledged ?? []);
  if (candidates.some((c) => !ack.has(c.id))) {
    throw new ConflictException({ statusCode: 409, message: ATHLETE_DUPLICATES_MESSAGE, candidates });
  }
}

function toAthleteData(dto: AdminAthleteCreateDto): AthleteData {
  return {
    display_name: dto.displayName,
    country_code: dto.countryCode ?? null,
    gender: dto.gender ?? null,
    birth_date: dto.birthDate ? parseBirthDate(dto.birthDate) : null,
  };
}

// Jour réel, entre 1900 et aujourd'hui : jamais une date future ou corrigée
// silencieusement (2004-02-30 refusé, pas décalé au 1er mars).
function parseBirthDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException("La date de naissance n'est pas une date valide");
  }
  if (value < MIN_BIRTH_DATE || date.getTime() > Date.now()) {
    throw new BadRequestException("La date de naissance doit être comprise entre 1900 et aujourd'hui");
  }
  return date;
}

function warningsFor(data: AthleteData): string[] {
  const warnings: string[] = [];
  if (!data.country_code) warnings.push("Code pays non renseigné : la détection des homonymes sera moins fiable.");
  return warnings;
}

function sameValue(a: string | Date | null, b: string | Date | null): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return a === b;
}

function day(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function toFieldsView(data: AthleteData) {
  return { displayName: data.display_name, countryCode: data.country_code, gender: data.gender, birthDate: day(data.birth_date) };
}

function toListItem(row: AthleteListRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    countryCode: row.country_code,
    gender: row.gender,
    birthDate: day(row.birth_date),
    origin: athleteOrigin(row.sources),
    sources: [...new Set(row.sources.map((s) => s.source))],
    // Un combat logique a deux athlètes distincts (CHECK) : jamais compté deux fois.
    fightCount: row._count.matches_as_a + row._count.matches_as_b,
  };
}
