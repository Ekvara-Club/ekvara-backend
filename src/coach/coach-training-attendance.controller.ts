import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachTrainingOwnershipGuard } from "../auth/coach-training-ownership.guard";
import { CoachTrainingAttendanceService } from "./coach-training-attendance.service";
import { PutCoachTrainingAttendanceDto } from "./dto/put-coach-training-attendance.dto";

// Même guard que CoachTrainingsController (CoachTrainingOwnershipGuard lit
// request.params.trainingId, qui reste identique ici) : GET et PUT sont
// tous deux 403 (jamais 404) pour un coach non propriétaire (ticket §14).
@Controller("coach/trainings/:trainingId/attendance")
@UseGuards(JwtAuthGuard, CoachTrainingOwnershipGuard)
export class CoachTrainingAttendanceController {
  constructor(private readonly attendanceService: CoachTrainingAttendanceService) {}

  @Get()
  getAttendance(@Param("trainingId", ParseUUIDPipe) trainingId: string) {
    return this.attendanceService.getAttendanceSheet(trainingId);
  }

  @Put()
  putAttendance(@Param("trainingId", ParseUUIDPipe) trainingId: string, @Body() dto: PutCoachTrainingAttendanceDto) {
    return this.attendanceService.putAttendance(trainingId, dto);
  }
}
