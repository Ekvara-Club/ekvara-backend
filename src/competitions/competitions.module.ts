import { Module } from "@nestjs/common";
import { AuthGuardsModule } from "../auth/auth-guards.module";
import { CompetitionsController } from "./competitions.controller";
import { CompetitionsService } from "./competitions.service";
import { CompetitionsRepository } from "./competitions.repository";
import { CompetitionEntriesService } from "./competition-entries.service";
import { CompetitionEntriesRepository } from "./competition-entries.repository";
import { FftdaImporterService } from "./importers/fftda-importer.service";
import { WtImporterService } from "./importers/world-taekwondo/wt-importer.service";
import { MartialEventsImporterService } from "./importers/martial-events/me-importer.service";

@Module({
  imports: [AuthGuardsModule],
  controllers: [CompetitionsController],
  providers: [
    CompetitionsService,
    CompetitionsRepository,
    CompetitionEntriesService,
    CompetitionEntriesRepository,
    FftdaImporterService,
    WtImporterService,
    MartialEventsImporterService,
  ],
  exports: [CompetitionsRepository],
})
export class CompetitionsModule {}
