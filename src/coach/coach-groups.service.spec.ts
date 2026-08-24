import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client";
import { CoachGroupsService } from "./coach-groups.service";
import { CoachGroupsRepository } from "./coach-groups.repository";

function uniqueConstraintError(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

describe("CoachGroupsService", () => {
  let service: CoachGroupsService;
  let repository: {
    createGroup: jest.Mock;
    findGroupsForCoach: jest.Mock;
    findGroupDetail: jest.Mock;
    renameGroup: jest.Mock;
    deleteGroup: jest.Mock;
    membershipExists: jest.Mock;
    addMember: jest.Mock;
    removeMember: jest.Mock;
  };

  const COACH_ID = "coach-1";
  const GROUP_ID = "group-1";
  const ATHLETE_ID = "athlete-1";

  beforeEach(async () => {
    repository = {
      createGroup: jest.fn(),
      findGroupsForCoach: jest.fn(),
      findGroupDetail: jest.fn(),
      renameGroup: jest.fn(),
      deleteGroup: jest.fn(),
      membershipExists: jest.fn(),
      addMember: jest.fn(),
      removeMember: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CoachGroupsService, { provide: CoachGroupsRepository, useValue: repository }],
    }).compile();

    service = module.get(CoachGroupsService);
  });

  describe("createGroup", () => {
    it("trim le nom avant création", async () => {
      repository.createGroup.mockResolvedValue({ id: GROUP_ID, name: "Élite" });

      await service.createGroup(COACH_ID, "  Élite  ");

      expect(repository.createGroup).toHaveBeenCalledWith(COACH_ID, "Élite");
    });

    it("nom vide après trim -> BadRequestException, pas d'appel repository", async () => {
      await expect(service.createGroup(COACH_ID, "   ")).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.createGroup).not.toHaveBeenCalled();
    });

    it("nom déjà utilisé par ce coach (contrainte unique coach_id+name) -> ConflictException", async () => {
      repository.createGroup.mockRejectedValue(uniqueConstraintError("coach_group_coach_id_name_key"));

      await expect(service.createGroup(COACH_ID, "Élite")).rejects.toBeInstanceOf(ConflictException);
    });

    it("groupe fraîchement créé -> athleteCount 0 sans requête supplémentaire", async () => {
      repository.createGroup.mockResolvedValue({ id: GROUP_ID, name: "Élite" });

      const result = await service.createGroup(COACH_ID, "Élite");

      expect(result).toEqual({ id: GROUP_ID, name: "Élite", athleteCount: 0 });
    });
  });

  describe("listGroups", () => {
    it("mappe _count.members -> athleteCount, trie par nom", async () => {
      repository.findGroupsForCoach.mockResolvedValue([
        { id: "g-2", name: "Juniors", _count: { members: 3 } },
        { id: "g-1", name: "Élite", _count: { members: 12 } },
      ]);

      const result = await service.listGroups(COACH_ID);

      expect(result).toEqual([
        { id: "g-1", name: "Élite", athleteCount: 12 },
        { id: "g-2", name: "Juniors", athleteCount: 3 },
      ]);
    });

    it("coach sans groupe -> []", async () => {
      repository.findGroupsForCoach.mockResolvedValue([]);
      expect(await service.listGroups(COACH_ID)).toEqual([]);
    });
  });

  describe("renameGroup", () => {
    it("nom en conflit -> ConflictException", async () => {
      repository.renameGroup.mockRejectedValue(uniqueConstraintError("coach_group_coach_id_name_key"));

      await expect(service.renameGroup(GROUP_ID, "Doublon")).rejects.toBeInstanceOf(ConflictException);
    });

    it("renomme avec succès, conserve athleteCount réel", async () => {
      repository.renameGroup.mockResolvedValue({ id: GROUP_ID, name: "Nouveau nom", _count: { members: 5 } });

      const result = await service.renameGroup(GROUP_ID, "Nouveau nom");

      expect(result).toEqual({ id: GROUP_ID, name: "Nouveau nom", athleteCount: 5 });
    });
  });

  describe("addAthlete", () => {
    it("déjà membre -> ConflictException, pas d'appel addMember", async () => {
      repository.membershipExists.mockResolvedValue(true);

      await expect(service.addAthlete(GROUP_ID, ATHLETE_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(repository.addMember).not.toHaveBeenCalled();
    });

    it("nouveau membre -> ajouté", async () => {
      repository.membershipExists.mockResolvedValue(false);
      repository.addMember.mockResolvedValue({ id: "m-1" });

      await service.addAthlete(GROUP_ID, ATHLETE_ID);

      expect(repository.addMember).toHaveBeenCalledWith(GROUP_ID, ATHLETE_ID);
    });
  });

  describe("removeAthlete", () => {
    it("pas membre -> NotFoundException", async () => {
      repository.membershipExists.mockResolvedValue(false);

      await expect(service.removeAthlete(GROUP_ID, ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.removeMember).not.toHaveBeenCalled();
    });

    it("membre existant -> retiré (coach_athlete jamais touché ici)", async () => {
      repository.membershipExists.mockResolvedValue(true);
      repository.removeMember.mockResolvedValue({ id: "m-1" });

      await service.removeAthlete(GROUP_ID, ATHLETE_ID);

      expect(repository.removeMember).toHaveBeenCalledWith(GROUP_ID, ATHLETE_ID);
    });
  });

  describe("getGroupDetail", () => {
    it("groupe introuvable -> NotFoundException (défensif, guard a déjà résolu le groupe)", async () => {
      repository.findGroupDetail.mockResolvedValue(null);
      await expect(service.getGroupDetail(GROUP_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("trie les athlètes par nom puis prénom, categoriePoids toujours null", async () => {
      repository.findGroupDetail.mockResolvedValue({
        id: GROUP_ID,
        name: "Élite",
        members: [
          { athlete: { id: "a-2", categorie_age: "senior", app_user: { nom: "Zidane", prenom: "Adam" } } },
          { athlete: { id: "a-1", categorie_age: "junior", app_user: { nom: "Ali", prenom: "Kais" } } },
        ],
      });

      const result = await service.getGroupDetail(GROUP_ID);

      expect(result.athletes.map((a: { id: string }) => a.id)).toEqual(["a-1", "a-2"]);
      expect(result.athletes[0]).toEqual({
        id: "a-1",
        prenom: "Kais",
        nom: "Ali",
        categorieAge: "junior",
        categoriePoids: null,
      });
    });
  });
});
