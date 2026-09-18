import { IsOptional, IsUUID } from "class-validator";

export class CreateInvitationDto {
  @IsOptional()
  @IsUUID()
  assignedGroupId?: string;
}
