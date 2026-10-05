import { buildSeriesOccurrences, formatWeekdaysFr, parisWallClockToUtc } from "./training-series.util";

describe("training-series.util", () => {
  describe("parisWallClockToUtc", () => {
    it("heure d'été (UTC+2) et heure d'hiver (UTC+1)", () => {
      expect(parisWallClockToUtc("2026-10-07", "20:00").toISOString()).toBe("2026-10-07T18:00:00.000Z");
      expect(parisWallClockToUtc("2026-11-04", "20:00").toISOString()).toBe("2026-11-04T19:00:00.000Z");
    });

    it("jour même du passage à l'heure d'hiver (25 oct. 2026) et d'été (28 mars 2027)", () => {
      expect(parisWallClockToUtc("2026-10-25", "20:00").toISOString()).toBe("2026-10-25T19:00:00.000Z");
      expect(parisWallClockToUtc("2027-03-28", "20:00").toISOString()).toBe("2027-03-28T18:00:00.000Z");
    });
  });

  describe("buildSeriesOccurrences", () => {
    it("tous les mercredis 20h pendant 1 mois : 20h heure de Paris de part et d'autre du changement d'heure", () => {
      const occurrences = buildSeriesOccurrences({
        startDate: "2026-10-07",
        startTime: "20:00",
        endTime: "21:30",
        weekdays: [3],
        durationMonths: 1,
      });

      // 7 oct. inclus -> 7 nov. exclu : 7, 14, 21, 28 oct. et 4 nov.
      expect(occurrences.map((o) => o.startAt.toISOString())).toEqual([
        "2026-10-07T18:00:00.000Z",
        "2026-10-14T18:00:00.000Z",
        "2026-10-21T18:00:00.000Z",
        "2026-10-28T19:00:00.000Z",
        "2026-11-04T19:00:00.000Z",
      ]);
      expect(occurrences[0].endAt?.toISOString()).toBe("2026-10-07T19:30:00.000Z");
      expect(occurrences[3].endAt?.toISOString()).toBe("2026-10-28T20:30:00.000Z");
    });

    it("plusieurs jours (mardi + jeudi), ordre chronologique, sans heure de fin", () => {
      const occurrences = buildSeriesOccurrences({
        startDate: "2026-10-05",
        startTime: "18:30",
        weekdays: [4, 2],
        durationMonths: 1,
      });

      expect(occurrences).toHaveLength(9);
      expect(occurrences[0].startAt.toISOString()).toBe("2026-10-06T16:30:00.000Z");
      expect(occurrences[1].startAt.toISOString()).toBe("2026-10-08T16:30:00.000Z");
      expect(occurrences.every((o) => o.endAt === undefined)).toBe(true);
    });

    it("la date de départ est incluse si elle tombe un jour choisi ; la date N mois plus tard est exclue", () => {
      const occurrences = buildSeriesOccurrences({
        startDate: "2026-10-07",
        startTime: "10:00",
        weekdays: [3],
        durationMonths: 12,
      });

      expect(occurrences[0].startAt.toISOString().slice(0, 10)).toBe("2026-10-07");
      // 7 oct. 2027 est un jeudi : la dernière occurrence est le mercredi 6 oct. 2027.
      expect(occurrences[occurrences.length - 1].startAt.toISOString().slice(0, 10)).toBe("2027-10-06");
      expect(occurrences).toHaveLength(53);
    });

    it("fin de fenêtre ramenée au dernier jour du mois (31 janv. + 1 mois = 28 févr. exclu)", () => {
      const occurrences = buildSeriesOccurrences({
        startDate: "2027-01-31",
        startTime: "10:00",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        durationMonths: 1,
      });

      // 31 janv. -> 27 févr. inclus : 28 jours, jamais un débordement sur mars.
      expect(occurrences).toHaveLength(28);
      expect(occurrences[occurrences.length - 1].startAt.toISOString().slice(0, 10)).toBe("2027-02-27");
    });
  });

  describe("formatWeekdaysFr", () => {
    it("ordre de la semaine, liaison « et »", () => {
      expect(formatWeekdaysFr([3])).toBe("mercredi");
      expect(formatWeekdaysFr([4, 2])).toBe("mardi et jeudi");
      expect(formatWeekdaysFr([5, 1, 3])).toBe("lundi, mercredi et vendredi");
    });
  });
});
