import "dotenv/config";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { describeOnTestDatabase } from "../test-utils/test-database";
import { AthletesService } from "./athletes.service";

// Intégration Postgres réelle (base de test isolée) : mensurations écrites,
// relues par la fiche (athlète et coach : même findOne), effacées par null.
describeOnTestDatabase("AthletesService.updateMeasurements (intégration Postgres)", () => {
  let prisma: PrismaService;
  let service: AthletesService;
  const runId = Date.now();
  let userId: string;
  let athleteId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    service = new AthletesService(prisma, new NotificationsRepository(prisma));
    const user = await prisma.app_user.create({ data: { email: `test-fixture-mensurations-${runId}@test.fr`, prenom: "Kaïs", nom: "Fixture" } });
    userId = user.id;
    athleteId = (await prisma.athlete.create({ data: { user_id: user.id } })).id;
  });

  afterAll(async () => {
    await prisma.app_user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("non renseignées par défaut ; écrites puis lues par la fiche ; null = effacé", async () => {
    expect(await service.findOne(athleteId)).toMatchObject({ taille_cm: null, longueur_bras_cm: null });

    expect(await service.updateMeasurements(athleteId, { tailleCm: 178, longueurBrasCm: 72 })).toEqual({ tailleCm: 178, longueurBrasCm: 72 });
    expect(await service.findOne(athleteId)).toMatchObject({ taille_cm: 178, longueur_bras_cm: 72 });

    // PUT = état complet : un champ absent vaut "non renseigné".
    expect(await service.updateMeasurements(athleteId, { tailleCm: 180 })).toEqual({ tailleCm: 180, longueurBrasCm: null });
    expect(await service.updateMeasurements(athleteId, { tailleCm: null, longueurBrasCm: null })).toEqual({ tailleCm: null, longueurBrasCm: null });
  });

  it("athlète inexistant -> 404", async () => {
    await expect(service.updateMeasurements("00000000-0000-4000-8000-000000000000", { tailleCm: 170 })).rejects.toBeInstanceOf(NotFoundException);
  });
});
