import { IsOptional, IsUUID } from "class-validator";

export class DashboardAthletesQueryDto {
  @IsOptional()
  @IsUUID()
  groupId?: string;
}
