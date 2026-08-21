import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ParticipationsService } from "./participations.service";
import { ParticipationsRepository } from "./participations.repository";
import { CompetitionsRepository } from "../competitions/competitions.repository";
import { Prisma } from "../../generated/prisma/client";

describe("ParticipationsService", () => {
  let service: ParticipationsService;
  let participationsRepository: {
    athleteExists: jest.Mock;
    findByAthleteAndCompetition: jest.Mock;
    create: jest.Mock;
    findAllByAthlete: jest.Mock;
    findNextByAthlete: jest.Mock;
    updateResult: jest.Mock;
  };
  let competitionsRepository: { findById: jest.Mock };

  const ATHLETE_ID = "240fe60f-6e74-46ea-87a0-45872bd1f4fe";
  const COMPETITION_ID = "d337932f-359b-4f5b-bab7-84a6f7cb8c94";

  const competitionRow = {
    id: COMPETITION_ID,
    nom: "Belgian Open",
    date_debut: new Date(Date.UTC(2026, 7, 15)),
    date_fin: null,
    lieu: null,
    ville: "Brussel",
    pays: "Belgium",
    niveau: "international",
    sources: [{ source: "world_taekwondo" }],
  };

  const participationRow = {
    id: "p-1",
    statut: "inscrit",
    categorie_poids: "-74 kg",
    categorie_age: "senior",
    classement: null,
    medaille: null,
    victoires: 0,
    defaites: 0,
    points_gagnes: 0,
    competition: competitionRow,
  };

  beforeEach(async () => {
    participationsRepository = {
      athleteExists: jest.fn(),
      findByAthleteAndCompetition: jest.fn(),
      create: jest.fn(),
      findAllByAthlete: jest.fn(),
      findNextByAthlete: jest.fn(),
      updateResult: jest.fn(),
    };
    competitionsRepository = { findById: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ParticipationsService,
        { provide: ParticipationsRepository, useValue: participationsRepository },
        { provide: CompetitionsRepository, useValue: competitionsRepository },
      ],
    }).compile();

    service = module.get<ParticipationsService>(ParticipationsService);
  });

  describe("participate", () => {
    it("inscrit l'athlète et renvoie une vue mappée en camelCase", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      competitionsRepository.findById.mockResolvedValue(competitionRow);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(null);
      participationsRepository.create.mockResolvedValue(participationRow);

      const result = await service.participate(ATHLETE_ID, COMPETITION_ID, {
        categoriePoids: "-74 kg",
        categorieAge: "senior",
      });

      expect(result).toEqual({
        id: "p-1",
        statut: "inscrit",
        categoriePoids: "-74 kg",
        categorieAge: "senior",
        classement: null,
        medaille: null,
        victoires: 0,
        defaites: 0,
        pointsGagnes: 0,
        competition: {
          id: COMPETITION_ID,
          nom: "Belgian Open",
          dateDebut: competitionRow.date_debut,
          dateFin: null,
          lieu: null,
          ville: "Brussel",
          pays: "Belgium",
          niveau: "international",
          source: "world_taekwondo",
        },
      });
      expect(participationsRepository.create).toHaveBeenCalledWith(ATHLETE_ID, COMPETITION_ID, {
        categoriePoids: "-74 kg",
        categorieAge: "senior",
      });
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(false);

      await expect(service.participate(ATHLETE_ID, COMPETITION_ID, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(competitionsRepository.findById).not.toHaveBeenCalled();
    });

    it("compétition inexistante -> NotFoundException (404)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      competitionsRepository.findById.mockResolvedValue(null);

      await expect(service.participate(ATHLETE_ID, COMPETITION_ID, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(participationsRepository.findByAthleteAndCompetition).not.toHaveBeenCalled();
    });

    it("participation déjà existante (vérification applicative) -> ConflictException (409)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      competitionsRepository.findById.mockResolvedValue(competitionRow);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(participationRow);

      await expect(service.participate(ATHLETE_ID, COMPETITION_ID, {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(participationsRepository.create).not.toHaveBeenCalled();
    });

    it("contrainte unique Prisma violée en concurrence (P2002) -> ConflictException (409), pas d'erreur brute", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      competitionsRepository.findById.mockResolvedValue(competitionRow);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(null);
      participationsRepository.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "7.9.1",
        }),
      );

      await expect(service.participate(ATHLETE_ID, COMPETITION_ID, {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe("findAllForAthlete", () => {
    it("retourne les participations mappées avec leur compétition", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findAllByAthlete.mockResolvedValue([participationRow]);

      const result = await service.findAllForAthlete(ATHLETE_ID);

      expect(result).toHaveLength(1);
      expect(result[0].competition.nom).toBe("Belgian Open");
      expect(result[0].categoriePoids).toBe("-74 kg");
    });

    it("athlète sans participation -> []", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findAllByAthlete.mockResolvedValue([]);

      const result = await service.findAllForAthlete(ATHLETE_ID);

      expect(result).toEqual([]);
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(false);

      await expect(service.findAllForAthlete(ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("findNextForAthlete", () => {
    it("retourne la vue 'next' avec participationId quand une compétition est trouvée", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findNextByAthlete.mockResolvedValue(participationRow);

      const result = await service.findNextForAthlete(ATHLETE_ID);

      expect(result).toEqual({
        participationId: "p-1",
        statut: "inscrit",
        categoriePoids: "-74 kg",
        categorieAge: "senior",
        competition: {
          id: COMPETITION_ID,
          nom: "Belgian Open",
          dateDebut: competitionRow.date_debut,
          dateFin: null,
          lieu: null,
          ville: "Brussel",
          pays: "Belgium",
          niveau: "international",
          source: "world_taekwondo",
        },
      });
    });

    it("aucune compétition future active -> null (200, pas 404)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findNextByAthlete.mockResolvedValue(null);

      const result = await service.findNextForAthlete(ATHLETE_ID);

      expect(result).toBeNull();
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(false);

      await expect(service.findNextForAthlete(ATHLETE_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("compare avec minuit UTC du jour courant (une compétition aujourd'hui reste éligible)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findNextByAthlete.mockResolvedValue(participationRow);

      await service.findNextForAthlete(ATHLETE_ID);

      const [, fromDate] = participationsRepository.findNextByAthlete.mock.calls[0];
      expect(fromDate.getUTCHours()).toBe(0);
      expect(fromDate.getUTCMinutes()).toBe(0);
      expect(fromDate.getUTCSeconds()).toBe(0);
    });
  });

  describe("updateResult", () => {
    // Dates construites relativement à "aujourd'hui" (minuit UTC) pour que les
    // tests restent valides quel que soit le jour d'exécution — jamais de date
    // en dur.
    function daysFromToday(offsetDays: number): Date {
      const now = new Date();
      const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      return new Date(todayUtcMidnight + offsetDays * 24 * 60 * 60 * 1000);
    }

    const rawParticipation = {
      id: "p-1",
      athlete_id: ATHLETE_ID,
      competition_id: COMPETITION_ID,
      statut: "inscrit",
      categorie_poids: "-74 kg",
      categorie_age: "senior",
      classement: 3,
      medaille: "bronze",
      victoires: 4,
      defaites: 1,
      points_gagnes: 0,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const pastCompetition = { ...competitionRow, date_debut: daysFromToday(-10), date_fin: null };
    const futureCompetition = { ...competitionRow, date_debut: daysFromToday(10), date_fin: null };
    const todayCompetition = { ...competitionRow, date_debut: daysFromToday(0), date_fin: null };
    const ongoingMultiDayCompetition = {
      ...competitionRow,
      date_debut: daysFromToday(-2),
      date_fin: daysFromToday(1),
    };
    const pastMultiDayCompetition = {
      ...competitionRow,
      date_debut: daysFromToday(-10),
      date_fin: daysFromToday(-8),
    };

    it("résultat complet valide (compétition passée) -> succès, tous les champs transmis au repository", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(pastCompetition);
      participationsRepository.updateResult.mockResolvedValue({
        ...participationRow,
        classement: 3,
        medaille: "bronze",
        victoires: 4,
        defaites: 1,
        competition: pastCompetition,
      });

      const result = await service.updateResult(ATHLETE_ID, COMPETITION_ID, {
        classement: 3,
        medaille: "bronze",
        victoires: 4,
        defaites: 1,
      });

      expect(participationsRepository.updateResult).toHaveBeenCalledWith("p-1", {
        classement: 3,
        medaille: "bronze",
        victoires: 4,
        defaites: 1,
      });
      expect(result.classement).toBe(3);
      expect(result.medaille).toBe("bronze");
    });

    it("résultat partiel valide (un seul champ) -> les autres clés restent undefined pour le repository", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(pastCompetition);
      participationsRepository.updateResult.mockResolvedValue({
        ...participationRow,
        classement: 2,
        competition: pastCompetition,
      });

      await service.updateResult(ATHLETE_ID, COMPETITION_ID, { classement: 2 });

      expect(participationsRepository.updateResult).toHaveBeenCalledWith("p-1", {
        classement: 2,
        medaille: undefined,
        victoires: undefined,
        defaites: undefined,
      });
    });

    it("victoires=0 explicitement fourni -> accepté et transmis (pas confondu avec absent)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(pastCompetition);
      participationsRepository.updateResult.mockResolvedValue({
        ...participationRow,
        victoires: 0,
        competition: pastCompetition,
      });

      await service.updateResult(ATHLETE_ID, COMPETITION_ID, { victoires: 0 });

      expect(participationsRepository.updateResult).toHaveBeenCalledWith(
        "p-1",
        expect.objectContaining({ victoires: 0 }),
      );
    });

    it("medaille: null explicitement fourni -> accepté et transmis (retrait de médaille, pas confondu avec absent)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(pastCompetition);
      participationsRepository.updateResult.mockResolvedValue({
        ...participationRow,
        medaille: null,
        competition: pastCompetition,
      });

      const result = await service.updateResult(ATHLETE_ID, COMPETITION_ID, { medaille: null });

      expect(participationsRepository.updateResult).toHaveBeenCalledWith(
        "p-1",
        expect.objectContaining({ medaille: null }),
      );
      expect(result.medaille).toBeNull();
    });

    it("medaille: null seul suffit à satisfaire la règle 'au moins un champ' -> pas de BadRequestException", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(pastCompetition);
      participationsRepository.updateResult.mockResolvedValue({
        ...participationRow,
        medaille: null,
        competition: pastCompetition,
      });

      await expect(
        service.updateResult(ATHLETE_ID, COMPETITION_ID, { medaille: null }),
      ).resolves.toBeDefined();
      expect(participationsRepository.updateResult).toHaveBeenCalled();
    });

    it("PATCH medaille: null ne modifie pas classement/victoires/defaites", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(pastCompetition);
      participationsRepository.updateResult.mockResolvedValue({
        ...participationRow,
        medaille: null,
        competition: pastCompetition,
      });

      await service.updateResult(ATHLETE_ID, COMPETITION_ID, { medaille: null });

      expect(participationsRepository.updateResult).toHaveBeenCalledWith("p-1", {
        classement: undefined,
        medaille: null,
        victoires: undefined,
        defaites: undefined,
      });
    });

    it("body vide -> BadRequestException (400), repository jamais appelé", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(pastCompetition);

      await expect(service.updateResult(ATHLETE_ID, COMPETITION_ID, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(participationsRepository.updateResult).not.toHaveBeenCalled();
    });

    it("compétition future -> BadRequestException (400)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(futureCompetition);

      await expect(
        service.updateResult(ATHLETE_ID, COMPETITION_ID, { classement: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(participationsRepository.updateResult).not.toHaveBeenCalled();
    });

    it("compétition aujourd'hui -> BadRequestException (400)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(todayCompetition);

      await expect(
        service.updateResult(ATHLETE_ID, COMPETITION_ID, { classement: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("compétition multi-jours encore en cours -> BadRequestException (400)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(ongoingMultiDayCompetition);

      await expect(
        service.updateResult(ATHLETE_ID, COMPETITION_ID, { classement: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("compétition multi-jours terminée -> succès", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(pastMultiDayCompetition);
      participationsRepository.updateResult.mockResolvedValue({
        ...participationRow,
        competition: pastMultiDayCompetition,
      });

      await expect(
        service.updateResult(ATHLETE_ID, COMPETITION_ID, { classement: 1 }),
      ).resolves.toBeDefined();
    });

    it("participation inexistante pour cet athlète et cette compétition -> NotFoundException (404)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(null);

      await expect(
        service.updateResult(ATHLETE_ID, COMPETITION_ID, { classement: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(competitionsRepository.findById).not.toHaveBeenCalled();
    });

    it("athlète inexistant -> NotFoundException (404)", async () => {
      participationsRepository.athleteExists.mockResolvedValue(false);

      await expect(
        service.updateResult(ATHLETE_ID, COMPETITION_ID, { classement: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(participationsRepository.findByAthleteAndCompetition).not.toHaveBeenCalled();
    });

    it("ne modifie jamais statut : absent du repository.updateResult", async () => {
      participationsRepository.athleteExists.mockResolvedValue(true);
      participationsRepository.findByAthleteAndCompetition.mockResolvedValue(rawParticipation);
      competitionsRepository.findById.mockResolvedValue(pastCompetition);
      participationsRepository.updateResult.mockResolvedValue({
        ...participationRow,
        competition: pastCompetition,
      });

      await service.updateResult(ATHLETE_ID, COMPETITION_ID, { classement: 1 });

      const [, data] = participationsRepository.updateResult.mock.calls[0];
      expect(data).not.toHaveProperty("statut");
      expect(data).not.toHaveProperty("points_gagnes");
    });
  });
});
