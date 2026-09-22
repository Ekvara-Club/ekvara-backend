import {
  assertValidEventTransition,
  assertValidRunTransition,
  initialEventStatus,
  isEventProcessable,
  isValidEventTransition,
  isValidRunTransition,
  runStatusAfterEventOutcome,
} from "./wt-backfill-state";

describe("wt-backfill-state (machine d'état pure)", () => {
  describe("run transitions", () => {
    it.each([
      ["PENDING", "RUNNING"],
      ["RUNNING", "COMPLETED"],
      ["RUNNING", "BLOCKED"],
      ["RUNNING", "FAILED"],
      ["BLOCKED", "RUNNING"],
      ["FAILED", "RUNNING"],
    ] as const)("%s -> %s est autorisée", (from, to) => {
      expect(isValidRunTransition(from, to)).toBe(true);
      expect(() => assertValidRunTransition(from, to)).not.toThrow();
    });

    it.each([
      ["PENDING", "COMPLETED"],
      ["PENDING", "BLOCKED"],
      ["PENDING", "FAILED"],
      ["COMPLETED", "RUNNING"],
      ["COMPLETED", "PENDING"],
      ["BLOCKED", "COMPLETED"],
      ["BLOCKED", "BLOCKED"],
      ["FAILED", "COMPLETED"],
      ["RUNNING", "PENDING"],
    ] as const)("%s -> %s est refusée", (from, to) => {
      expect(isValidRunTransition(from, to)).toBe(false);
      expect(() => assertValidRunTransition(from, to)).toThrow();
    });

    it("un run COMPLETED n'a aucune transition sortante (terminal)", () => {
      expect(isValidRunTransition("COMPLETED", "RUNNING")).toBe(false);
      expect(isValidRunTransition("COMPLETED", "COMPLETED")).toBe(false);
    });
  });

  describe("event transitions", () => {
    it.each([
      ["PENDING", "RUNNING"],
      ["RUNNING", "COMPLETED"],
      ["RUNNING", "BLOCKED"],
      ["RUNNING", "FAILED"],
      ["RUNNING", "PENDING"], // stale recovery / interruption propre
      ["BLOCKED", "PENDING"], // retry
      ["FAILED", "PENDING"], // retry
    ] as const)("%s -> %s est autorisée", (from, to) => {
      expect(isValidEventTransition(from, to)).toBe(true);
      expect(() => assertValidEventTransition(from, to)).not.toThrow();
    });

    it.each([
      ["COMPLETED", "PENDING"],
      ["COMPLETED", "RUNNING"],
      ["PENDING", "COMPLETED"],
      ["PENDING", "BLOCKED"],
      ["BLOCKED", "RUNNING"],
      ["FAILED", "RUNNING"],
      ["BLOCKED", "COMPLETED"],
    ] as const)("%s -> %s est refusée", (from, to) => {
      expect(isValidEventTransition(from, to)).toBe(false);
      expect(() => assertValidEventTransition(from, to)).toThrow();
    });

    it("un event COMPLETED n'est jamais retraité implicitement (terminal)", () => {
      expect(isValidEventTransition("COMPLETED", "PENDING")).toBe(false);
      expect(isValidEventTransition("COMPLETED", "RUNNING")).toBe(false);
    });
  });

  describe("initialEventStatus", () => {
    it("SAFE -> PENDING (traitable immédiatement)", () => {
      expect(initialEventStatus("SAFE")).toBe("PENDING");
    });
    it.each(["AMBIGUOUS", "UNMATCHED"] as const)("%s -> BLOCKED (jamais traité sans retry explicite)", (verdict) => {
      expect(initialEventStatus(verdict)).toBe("BLOCKED");
    });
  });

  describe("isEventProcessable", () => {
    it("seul PENDING est traitable", () => {
      expect(isEventProcessable("PENDING")).toBe(true);
      for (const s of ["RUNNING", "COMPLETED", "BLOCKED", "FAILED"] as const) {
        expect(isEventProcessable(s)).toBe(false);
      }
    });
  });

  describe("runStatusAfterEventOutcome (fail-closed)", () => {
    it("un event COMPLETED ne force aucun changement de statut de run", () => {
      expect(runStatusAfterEventOutcome("COMPLETED")).toBeNull();
    });
    it("un event BLOCKED arrête le run en BLOCKED", () => {
      expect(runStatusAfterEventOutcome("BLOCKED")).toBe("BLOCKED");
    });
    it("un event FAILED arrête le run en FAILED", () => {
      expect(runStatusAfterEventOutcome("FAILED")).toBe("FAILED");
    });
  });
});
