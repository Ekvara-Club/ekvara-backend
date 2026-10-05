import "dotenv/config";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { deleteAthleteAccount, exportAthleteData } from "./athletes.service";

// Intégration Postgres réelle : export complet et suppression en cascade
// d'un athlète qui a des données dans la plupart des tables.
describe("RGPD — export et suppression du compte athlète (intégration Postgres)", () => {
  let prisma: PrismaService;
  const runId = Date.now();
  const userIds: string[] = [];
  let competitionId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    competitionId = (await prisma.competition.create({ data: { nom: `Open RGPD ${runId}`, date_debut: new Date("2026-05-10") } })).id;
  });

  afterAll(async () => {
    await prisma.app_user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.competition.deleteMany({ where: { id: competitionId } });
    await prisma.$disconnect();
  });

  async function athleteWithData(tag: string) {
    const user = await prisma.app_user.create({ data: { email: `test-fixture-rgpd-${tag}-${runId}@test.fr`, prenom: "Léa", nom: "Rgpd" } });
    userIds.push(user.id);
    const athlete = await prisma.athlete.create({ data: { user_id: user.id, etat_forme: "blesse", etat_forme_note: "Entorse" } });
    const metric = await prisma.metric_type.findFirstOrThrow({ where: { code: "vitesse" } });
    await prisma.weight_log.create({ data: { athlete_id: athlete.id, valeur_kg: 60 } });
    await prisma.weight_target.create({ data: { athlete_id: athlete.id, poids_cible_kg: 58 } });
    const goal = await prisma.athlete_goal.create({ data: { athlete_id: athlete.id, titre: "Objectif RGPD" } });
    await prisma.goal_step.create({ data: { goal_id: goal.id, titre: "Étape" } });
    await prisma.metric_measurement.create({ data: { athlete_id: athlete.id, metric_type_id: metric.id, valeur: 70 } });
    await prisma.training_session.create({ data: { athlete_id: athlete.id, titre: "Séance", date_debut: new Date() } });
    await prisma.participation.create({ data: { athlete_id: athlete.id, competition_id: competitionId, classement: 3 } });
    await prisma.notification.create({ data: { recipient_user_id: user.id, context: "ATHLETE", type: "GOAL_UPDATED", title: "t" } });
    return { user, athlete };
  }

  it("export : profil, données sportives et notifications, jamais le hash du mot de passe", async () => {
    const { athlete } = await athleteWithData("export");

    const data = await exportAthleteData(prisma, athlete.id);

    expect(data.athlete.app_user).toEqual(expect.objectContaining({ email: expect.stringContaining("rgpd-export"), prenom: "Léa" }));
    expect(JSON.stringify(data)).not.toContain("password_hash");
    expect(data.athlete.etat_forme).toBe("blesse");
    expect(data.athlete.weight_log).toHaveLength(1);
    expect(data.athlete.athlete_goal[0].goal_step).toHaveLength(1);
    expect(data.athlete.metric_measurement[0].metric_type.code).toBe("vitesse");
    expect(data.athlete.participation[0].competition.nom).toBe(`Open RGPD ${runId}`);
    expect(data.notifications).toHaveLength(1);
  });

  it("suppression : compte et toutes ses données effacés ; la compétition (catalogue global) reste", async () => {
    const { user, athlete } = await athleteWithData("delete");

    await deleteAthleteAccount(prisma, athlete.id);

    expect(await prisma.app_user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.athlete.findUnique({ where: { id: athlete.id } })).toBeNull();
    expect(await prisma.weight_log.count({ where: { athlete_id: athlete.id } })).toBe(0);
    expect(await prisma.participation.count({ where: { athlete_id: athlete.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { recipient_user_id: user.id } })).toBe(0);
    expect(await prisma.competition.findUnique({ where: { id: competitionId } })).not.toBeNull();
  });

  it("compte aussi coach : suppression refusée (409), rien n'est effacé", async () => {
    const { user, athlete } = await athleteWithData("hybride");
    await prisma.coach_profile.create({ data: { user_id: user.id } });

    await expect(deleteAthleteAccount(prisma, athlete.id)).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.athlete.findUnique({ where: { id: athlete.id } })).not.toBeNull();
  });
});
