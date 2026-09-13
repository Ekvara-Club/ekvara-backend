import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { CoachTrainingsService } from "./coach-trainings.service";
import { CoachTrainingsRepository } from "./coach-trainings.repository";
import { CoachDestinataireResolver } from "./coach-destinataire-resolver";

describe("CoachTrainingsService", () => {
  let service: CoachTrainingsService;
  let repository: {
    createSessionWithAssignments: jest.Mock;
    findSessionsForCoach: jest.Mock;
    findSessionDetail: jest.Mock;
    updateContentAndPropagate: jest.Mock;
    findCurrentAssignments: jest.Mock;
    replaceAssignments: jest.Mock;
    findAttendanceForTrainingSessions: jest.Mock;
    cancel: jest.Mock;
  };
  let destinataireResolver: { resolve: jest.Mock };

  const COACH_ID = "coach-1";
  const SESSION_ID = "session-1";
  const GROUP_ID = "group-1";
  const ATHLETE_A = "athlete-a";
  const ATHLETE_B = "athlete-b";
  const ACTOR_USER_ID = "coach-user-1";

  function detail(overrides: Record<string, unknown> = {}) {
    return {
      id: SESSION_ID,
      titre: "Combat",
      type_seance: null,
      sous_type: null,
      date_debut: new Date("2026-09-05T18:00:00.000Z"),
      date_fin: null,
      lieu: null,
      niveau: null,
      description: null,
      statut: "prevu",
      assignments: [],
      group_sources: [],
      ...overrides,
    };
  }

  beforeEach(async () => {
    repository = {
      createSessionWithAssignments: jest.fn(),
      findSessionsForCoach: jest.fn(),
      findSessionDetail: jest.fn(),
      updateContentAndPropagate: jest.fn(),
      findCurrentAssignments: jest.fn(),
      replaceAssignments: jest.fn(),
      // Défaut : aucune présence enregistrée sur les training_session
      // retirés -> le blocage (ticket "Présences Coach V1" §3) ne se
      // déclenche jamais par défaut dans ces tests, qui n'exercent pas ce cas
      // (voir coach-training-attendance.spec.ts, intégration Postgres réelle,
      // pour ce cas précis).
      findAttendanceForTrainingSessions: jest.fn().mockResolvedValue([]),
      cancel: jest.fn(),
    };
    destinataireResolver = { resolve: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoachTrainingsService,
        { provide: CoachTrainingsRepository, useValue: repository },
        { provide: CoachDestinataireResolver, useValue: destinataireResolver },
      ],
    }).compile();

    service = module.get(CoachTrainingsService);
  });

  describe("createTraining — résolution des destinataires (déléguée à CoachDestinataireResolver)", () => {
    it("destinataire non autorisé -> l'exception du resolver remonte telle quelle, jamais d'écriture (échec complet, ticket §8)", async () => {
      destinataireResolver.resolve.mockRejectedValue(
        new ForbiddenException("Un ou plusieurs groupes n'appartiennent pas à ce coach"),
      );

      await expect(
        service.createTraining(COACH_ID, ACTOR_USER_ID, {
          title: "Combat",
          startAt: "2026-09-05T18:00:00.000Z",
          groupIds: [GROUP_ID],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.createSessionWithAssignments).not.toHaveBeenCalled();
    });

    it("aucun destinataire résolu -> BadRequestException du resolver, jamais d'écriture", async () => {
      destinataireResolver.resolve.mockRejectedValue(
        new BadRequestException("Au moins un destinataire (groupe ou athlète) est requis"),
      );

      await expect(
        service.createTraining(COACH_ID, ACTOR_USER_ID, { title: "Combat", startAt: "2026-09-05T18:00:00.000Z" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.createSessionWithAssignments).not.toHaveBeenCalled();
    });

    it("utilise l'union résolue (dédoublonnée) renvoyée par le resolver pour créer la session", async () => {
      destinataireResolver.resolve.mockResolvedValue({
        athleteIds: [ATHLETE_A, ATHLETE_B],
        groupIds: [GROUP_ID],
        groupMembers: [],
      });
      repository.createSessionWithAssignments.mockResolvedValue(SESSION_ID);
      repository.findSessionDetail.mockResolvedValue(detail());

      await service.createTraining(COACH_ID, ACTOR_USER_ID, {
        title: "Combat",
        startAt: "2026-09-05T18:00:00.000Z",
        groupIds: [GROUP_ID],
        athleteIds: [ATHLETE_A],
      });

      expect(destinataireResolver.resolve).toHaveBeenCalledWith(COACH_ID, [GROUP_ID], [ATHLETE_A]);
      const [, , athletes, groupIds] = repository.createSessionWithAssignments.mock.calls[0];
      expect(athletes.map((a: { athleteId: string }) => a.athleteId).sort()).toEqual([ATHLETE_A, ATHLETE_B].sort());
      expect(groupIds).toEqual([GROUP_ID]);
    });

    it("endAt <= startAt -> BadRequestException, avant même d'appeler le resolver", async () => {
      await expect(
        service.createTraining(COACH_ID, ACTOR_USER_ID, {
          title: "Combat",
          startAt: "2026-09-05T18:00:00.000Z",
          endAt: "2026-09-05T17:00:00.000Z",
          athleteIds: [ATHLETE_A],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(destinataireResolver.resolve).not.toHaveBeenCalled();
    });
  });

  describe("findOneForCoach", () => {
    it("séance introuvable -> NotFoundException", async () => {
      repository.findSessionDetail.mockResolvedValue(null);
      await expect(service.findOneForCoach(SESSION_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("mappe assignments.athleteCount / athletes / groups correctement", async () => {
      repository.findSessionDetail.mockResolvedValue(
        detail({
          assignments: [
            { training_session_id: "ts-1", athlete: { id: ATHLETE_A, app_user: { prenom: "Kais", nom: "Ali" } } },
          ],
          group_sources: [{ coach_group: { id: GROUP_ID, name: "Élite" } }],
        }),
      );

      const result = await service.findOneForCoach(SESSION_ID);

      expect(result.assignments).toEqual({
        athleteCount: 1,
        athletes: [{ id: ATHLETE_A, firstName: "Kais", lastName: "Ali" }],
        groups: [{ id: GROUP_ID, name: "Élite" }],
      });
    });
  });

  describe("updateContent", () => {
    it("aucun champ fourni -> BadRequestException", async () => {
      await expect(service.updateContent(SESSION_ID, ACTOR_USER_ID, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.updateContentAndPropagate).not.toHaveBeenCalled();
    });

    it("séance introuvable -> NotFoundException", async () => {
      repository.findSessionDetail.mockResolvedValue(null);
      await expect(service.updateContent(SESSION_ID, ACTOR_USER_ID, { title: "Nouveau" })).rejects.toBeInstanceOf(NotFoundException);
    });

    it("modifier endAt seul sans casser la cohérence avec le startAt EXISTANT -> validé contre la valeur actuelle", async () => {
      repository.findSessionDetail.mockResolvedValue(
        detail({ date_debut: new Date("2026-09-05T18:00:00.000Z"), date_fin: null }),
      );

      await expect(
        service.updateContent(SESSION_ID, ACTOR_USER_ID, { endAt: "2026-09-05T17:00:00.000Z" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.updateContentAndPropagate).not.toHaveBeenCalled();
    });

    it("modification valide -> propage uniquement les champs fournis", async () => {
      repository.findSessionDetail
        .mockResolvedValueOnce(detail())
        .mockResolvedValueOnce(detail({ date_debut: new Date("2026-09-05T20:30:00.000Z") }));

      await service.updateContent(SESSION_ID, ACTOR_USER_ID, { startAt: "2026-09-05T20:30:00.000Z" });

      expect(repository.updateContentAndPropagate).toHaveBeenCalledWith(
        SESSION_ID,
        expect.objectContaining({ date_debut: new Date("2026-09-05T20:30:00.000Z") }),
        expect.objectContaining({ actorUserId: ACTOR_USER_ID }),
      );
      // Seul date_debut était fourni : pas de titre/lieu/etc. dans le patch.
      const [, patch] = repository.updateContentAndPropagate.mock.calls[0];
      expect(Object.keys(patch)).toEqual(["date_debut"]);
    });
  });

  describe("replaceAssignments — diff add/remove/keep", () => {
    it("calcule correctement toAdd et toRemove à partir de l'état courant", async () => {
      repository.findSessionDetail.mockResolvedValue(detail());
      destinataireResolver.resolve.mockResolvedValue({ athleteIds: ["athlete-c"], groupIds: [], groupMembers: [] });
      repository.findCurrentAssignments.mockResolvedValue([
        { athlete_id: ATHLETE_A, training_session_id: "ts-a" },
        { athlete_id: ATHLETE_B, training_session_id: "ts-b" },
      ]);

      await service.replaceAssignments(COACH_ID, ACTOR_USER_ID, SESSION_ID, { groupIds: [], athleteIds: ["athlete-c"] });

      const [, , toAdd, toRemoveTrainingSessionIds] = repository.replaceAssignments.mock.calls[0];
      expect(toAdd).toEqual([{ athleteId: "athlete-c", groupId: null }]);
      expect(toRemoveTrainingSessionIds.sort()).toEqual(["ts-a", "ts-b"].sort());
    });

    it("athlètes inchangés -> ni add ni remove", async () => {
      repository.findSessionDetail.mockResolvedValue(detail());
      destinataireResolver.resolve.mockResolvedValue({ athleteIds: [ATHLETE_A], groupIds: [], groupMembers: [] });
      repository.findCurrentAssignments.mockResolvedValue([{ athlete_id: ATHLETE_A, training_session_id: "ts-a" }]);

      await service.replaceAssignments(COACH_ID, ACTOR_USER_ID, SESSION_ID, { groupIds: [], athleteIds: [ATHLETE_A] });

      const [, , toAdd, toRemove] = repository.replaceAssignments.mock.calls[0];
      expect(toAdd).toEqual([]);
      expect(toRemove).toEqual([]);
    });

    it("destinataire non autorisé -> l'exception du resolver remonte, aucun appel repository.replaceAssignments", async () => {
      repository.findSessionDetail.mockResolvedValue(detail());
      destinataireResolver.resolve.mockRejectedValue(
        new ForbiddenException("Un ou plusieurs athlètes ne sont pas assignés à ce coach"),
      );

      await expect(
        service.replaceAssignments(COACH_ID, ACTOR_USER_ID, SESSION_ID, { groupIds: [], athleteIds: [ATHLETE_A] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.replaceAssignments).not.toHaveBeenCalled();
    });
  });

  describe("cancel", () => {
    it("délègue à repository.cancel puis renvoie la fiche à jour", async () => {
      repository.findSessionDetail.mockResolvedValue(detail({ statut: "annule" }));

      const result = await service.cancel(SESSION_ID, ACTOR_USER_ID);

      expect(repository.cancel).toHaveBeenCalledWith(SESSION_ID, ACTOR_USER_ID);
      expect(result.status).toBe("annule");
    });
  });

  describe("findAllForCoach", () => {
    it("mappe athleteCount depuis _count.assignments", async () => {
      repository.findSessionsForCoach.mockResolvedValue([
        {
          id: SESSION_ID,
          titre: "Combat",
          type_seance: null,
          sous_type: null,
          date_debut: new Date(),
          date_fin: null,
          lieu: null,
          niveau: null,
          description: null,
          statut: "prevu",
          _count: { assignments: 3 },
        },
      ]);

      const result = await service.findAllForCoach(COACH_ID);

      expect(result[0].athleteCount).toBe(3);
    });

    it("coach sans séance -> []", async () => {
      repository.findSessionsForCoach.mockResolvedValue([]);
      expect(await service.findAllForCoach(COACH_ID)).toEqual([]);
    });
  });
});
