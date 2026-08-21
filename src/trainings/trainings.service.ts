import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { training_session } from "../../generated/prisma/client";
import { CreateTrainingDto } from "./dto/create-training.dto";
import { TrainingsRepository } from "./trainings.repository";

@Injectable()
export class TrainingsService {
  constructor(private readonly trainingsRepository: TrainingsRepository) {}

  async createTraining(athleteId: string, dto: CreateTrainingDto) {
    await this.assertAthleteExists(athleteId);

    const startAt = new Date(dto.startAt);
    const endAt = dto.endAt ? new Date(dto.endAt) : undefined;

    if (endAt && endAt <= startAt) {
      throw new BadRequestException("date_fin doit être strictement postérieure à date_debut");
    }

    const created = await this.trainingsRepository.createTraining(athleteId, {
      title: dto.title,
      type: dto.type,
      subType: dto.subType,
      startAt,
      endAt,
      location: dto.location,
      level: dto.level,
      description: dto.description,
    });

    return toTrainingView(created);
  }

  async findAllForAthlete(athleteId: string, range?: { from: Date; to: Date }) {
    await this.assertAthleteExists(athleteId);

    const trainings = await this.trainingsRepository.findAllByAthlete(athleteId, range);
    return trainings.map(toTrainingView);
  }

  async findNextForAthlete(athleteId: string) {
    await this.assertAthleteExists(athleteId);

    const next = await this.trainingsRepository.findNextByAthlete(athleteId, new Date());
    return next ? toTrainingView(next) : null;
  }

  private async assertAthleteExists(athleteId: string): Promise<void> {
    const exists = await this.trainingsRepository.athleteExists(athleteId);
    if (!exists) {
      throw new NotFoundException(`Athlete ${athleteId} introuvable`);
    }
  }
}

function toTrainingView(training: training_session) {
  return {
    id: training.id,
    title: training.titre,
    type: training.type_seance,
    subType: training.sous_type,
    startAt: training.date_debut,
    endAt: training.date_fin,
    location: training.lieu,
    level: training.niveau,
    description: training.description,
    status: training.statut,
  };
}
