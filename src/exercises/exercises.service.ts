import { Injectable, NotFoundException } from "@nestjs/common";
import { ExercisesRepository, ExerciseView } from "./exercises.repository";

@Injectable()
export class ExercisesService {
  constructor(private readonly exercisesRepository: ExercisesRepository) {}

  findAll(): Promise<ExerciseView[]> {
    return this.exercisesRepository.findMany();
  }

  async findOne(id: string): Promise<ExerciseView> {
    const exercise = await this.exercisesRepository.findById(id);
    if (!exercise) {
      throw new NotFoundException(`Exercice ${id} introuvable`);
    }
    return exercise;
  }
}
