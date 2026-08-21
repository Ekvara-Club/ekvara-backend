import { IsIn } from "class-validator";

const ALLOWED_STATUSES = ["en_cours", "atteint", "abandonne"] as const;

export type GoalStatus = (typeof ALLOWED_STATUSES)[number];

export class UpdateGoalStatusDto {
  @IsIn(ALLOWED_STATUSES)
  statut!: GoalStatus;
}
