import { Injectable, NotFoundException } from "@nestjs/common";
import { ExercisesRepository, ExerciseView } from "./exercises.repository";

@Injectable()
export class ExercisesService {
  constructor(private readonly exercisesRepository: ExercisesRepository) {}

  // athleteId optionnel : présent pour une session athlète (filtre
  // global + assignés), absent pour une session coach-only (globaux
  // uniquement — voir ExercisesRepository.visibilityWhere).
  findAll(athleteId?: string): Promise<ExerciseView[]> {
    return this.exercisesRepository.findMany(athleteId);
  }

  async findOne(id: string, athleteId?: string): Promise<ExerciseView> {
    const exercise = await this.exercisesRepository.findById(id, athleteId);
    if (!exercise) {
      // Même exception qu'un exercice réellement inexistant : ne jamais
      // laisser deviner qu'un exercice coach existe mais est privé.
      throw new NotFoundException(`Exercice ${id} introuvable`);
    }
    return exercise;
  }
}
