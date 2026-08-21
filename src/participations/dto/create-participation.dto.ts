import { IsOptional, IsString, MaxLength } from "class-validator";

export class CreateParticipationDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  categoriePoids?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  categorieAge?: string;
}
