import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { competition as CompetitionModel } from "../../generated/prisma/client";
import { CompetitionsRepository } from "./competitions.repository";
import { CompetitionEntriesRepository } from "./competition-entries.repository";
import { FftdaImporterService } from "./importers/fftda-importer.service";
import { WtImporterService } from "./importers/world-taekwondo/wt-importer.service";
import { MartialEventsImporterService } from "./importers/martial-events/me-importer.service";
import { ImportedCompetition } from "./importers/imported-competition.interface";

@Injectable()
export class CompetitionsService {
  private readonly logger = new Logger(CompetitionsService.name);

  constructor(
    private readonly competitionsRepository: CompetitionsRepository,
    private readonly competitionEntriesRepository: CompetitionEntriesRepository,
    private readonly fftdaImporterService: FftdaImporterService,
    private readonly wtImporterService: WtImporterService,
    private readonly martialEventsImporterService: MartialEventsImporterService,
  ) {}

  findAll() {
    return this.competitionsRepository.findMany();
  }

  async findOne(id: string) {
    const competition = await this.competitionsRepository.findById(id);
    if (!competition) {
      throw new NotFoundException(`Competition ${id} introuvable`);
    }
    return toCompetitionDetailView(competition);
  }

  async importFftda() {
    const { competitions, detected, failed } = await this.fftdaImporterService.fetchCompetitions();
    const { imported, updated, upsertFailed } = await this.upsertAll("FFTDA", competitions);

    const summary = {
      source: "fftda",
      fetched: detected,
      imported,
      updated,
      failed: failed + upsertFailed,
    };

    this.logger.log(
      `Import FFTDA terminé: ${imported} créées, ${updated} mises à jour, ${summary.failed} échouées`,
    );

    return summary;
  }

  async importWorldTaekwondo(year: number) {
    const { competitions, detected, failed } = await this.wtImporterService.fetchCompetitions(year);
    const { imported, updated, upsertFailed } = await this.upsertAll("WT", competitions);

    const summary = {
      source: "world_taekwondo",
      year,
      fetched: detected,
      imported,
      updated,
      failed: failed + upsertFailed,
    };

    this.logger.log(
      `Import WT ${year} terminé: ${imported} créées, ${updated} mises à jour, ${summary.failed} échouées`,
    );

    return summary;
  }

  // Pour chaque événement découvert : fetch compétition → upsert (pipeline
  // multi-source commun) → fetch /entries → synchronise competition_entry
  // sur la competition CANONIQUE retournée par l'upsert (jamais un id
  // Martial Events). La synchronisation des entries n'est jamais appelée si
  // le fetch/parse des entries a échoué — les anciennes entries restent
  // alors telles quelles (voir CompetitionEntriesRepository).
  async importMartialEvents() {
    const discovered = await this.martialEventsImporterService.discoverUpcomingEvents();

    let imported = 0;
    let updated = 0;
    let attached = 0;
    let failed = 0;
    let entriesImported = 0;
    let entriesUpdated = 0;
    let entriesRemoved = 0;
    let entriesFailed = 0;

    for (const event of discovered) {
      let competition: ImportedCompetition | null;
      try {
        competition = await this.martialEventsImporterService.fetchCompetition(event.slug);
      } catch (error) {
        failed++;
        this.logger.warn(
          `Échec de récupération Martial Events pour "${event.slug}": ${(error as Error).message}`,
        );
        continue;
      }
      if (!competition) {
        failed++;
        continue;
      }

      let upserted;
      try {
        upserted = await this.competitionsRepository.upsertFromSource(competition);
      } catch (error) {
        failed++;
        this.logger.warn(
          `Échec d'upsert pour la compétition Martial Events "${competition.nom}": ${(error as Error).message}`,
        );
        continue;
      }

      if (upserted.outcome === "created") imported++;
      else if (upserted.outcome === "attachedSafe") attached++;
      else updated++;

      try {
        const categories = await this.martialEventsImporterService.fetchEntries(event.slug);
        const sync = await this.competitionEntriesRepository.syncForCompetition(
          upserted.competition.id,
          "martial_events",
          categories,
        );
        entriesImported += sync.imported;
        entriesUpdated += sync.updated;
        entriesRemoved += sync.removed;
      } catch (error) {
        entriesFailed++;
        this.logger.warn(
          `Échec de synchronisation des entries Martial Events pour "${competition.nom}": ${(error as Error).message}`,
        );
      }
    }

    const summary = {
      source: "martial_events",
      fetched: discovered.length,
      imported,
      updated,
      attached,
      failed,
      entriesImported,
      entriesUpdated,
      entriesRemoved,
      entriesFailed,
    };

    this.logger.log(
      `Import Martial Events terminé: ${imported} créées, ${updated} mises à jour, ${attached} rattachées (SAFE), ${failed} échouées ; entries: ${entriesImported} créées, ${entriesUpdated} mises à jour, ${entriesRemoved} retirées, ${entriesFailed} échecs de synchronisation`,
    );

    return summary;
  }

  private async upsertAll(sourceLabel: string, competitions: ImportedCompetition[]) {
    let imported = 0;
    let updated = 0;
    let upsertFailed = 0;

    for (const competition of competitions) {
      try {
        const { created } = await this.competitionsRepository.upsertFromSource(competition);
        if (created) {
          imported++;
        } else {
          updated++;
        }
      } catch (error) {
        upsertFailed++;
        this.logger.warn(
          `Échec d'upsert pour la compétition ${sourceLabel} "${competition.nom}": ${(error as Error).message}`,
        );
      }
    }

    return { imported, updated, upsertFailed };
  }
}

// Vue stable pour la fiche compétition : ne renvoie jamais l'objet Prisma brut
// (created_at/updated_at internes), et laisse passer telle quelle une valeur
// null (organisateur/saison/lieu ne sont pas renseignés par les importeurs
// actuels) plutôt que de la remplacer par une valeur devinée.
//
// source/sourceExternalId : depuis la migration competition_source, ce ne
// sont plus des colonnes natives de competition — CompetitionsRepository les
// dérive de la "source primaire" (première competition_source créée pour
// cette competition), pour ne pas casser le contrat frontend existant.
function toCompetitionDetailView(
  competition: CompetitionModel & { source: string | null; source_external_id: string | null },
) {
  return {
    id: competition.id,
    nom: competition.nom,
    organisateur: competition.organisateur,
    source: competition.source,
    sourceExternalId: competition.source_external_id,
    dateDebut: competition.date_debut,
    dateFin: competition.date_fin,
    lieu: competition.lieu,
    ville: competition.ville,
    pays: competition.pays,
    niveau: competition.niveau,
    saison: competition.saison,
  };
}
