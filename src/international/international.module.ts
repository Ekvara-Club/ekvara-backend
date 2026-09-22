import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { CompetitionMatchesController } from "./competition-matches.controller";
import { InternationalAthletesController } from "./international-athletes.controller";
import { InternationalRepository } from "./international.repository";
import { InternationalService } from "./international.service";
import { WorldTaekwondoResultsImporterService } from "./wt-results/wt-results-importer.service";
import { WtResultsImportService } from "./wt-results/wt-results-import.service";
import { WtBackfillRepository } from "./wt-backfill/wt-backfill.repository";
import { WtBackfillService } from "./wt-backfill/wt-backfill.service";

// Athlètes publics/internationaux, matchs et leur import depuis World
// Taekwondo Results (ticket "WT Results Data Foundation V1"). Aucune
// dépendance vers CompetitionsModule : les competitions canoniques sont lues
// par id / rattachées via competition_source depuis ce module, sans toucher au
// module Competitions existant.
@Module({
  imports: [AuthGuardsModule],
  controllers: [InternationalAthletesController, CompetitionMatchesController],
  providers: [
    InternationalService,
    InternationalRepository,
    WorldTaekwondoResultsImporterService,
    WtResultsImportService,
    WtBackfillRepository,
    WtBackfillService,
  ],
})
export class InternationalModule {}
