import "dotenv/config";
import { randomUUID } from "crypto";
import { RunLockBusyError, withRunLock } from "./wt-backfill-lock";

// Intégration Postgres réelle (CLAUDE.md §23) : un advisory lock est un vrai
// comportement serveur, un mock ne peut pas le valider. Chaque test utilise
// un runId aléatoire distinct pour ne jamais interférer avec un autre test.
describe("wt-backfill-lock (double-run protection, intégration Postgres)", () => {
  it("un deuxième acquire échoue tant que le premier tient le lock, puis réussit après relâche", async () => {
    const runId = randomUUID();
    let secondAcquired = false;
    let secondError: unknown = null;

    await withRunLock(runId, async () => {
      // Pendant que le premier tient le lock, un second essai concurrent doit échouer.
      try {
        await withRunLock(runId, async () => {
          secondAcquired = true;
        });
      } catch (error) {
        secondError = error;
      }
    });

    expect(secondAcquired).toBe(false);
    expect(secondError).toBeInstanceOf(RunLockBusyError);

    // Le premier a relâché son lock (fin du withRunLock) : un nouvel essai réussit maintenant.
    let thirdAcquired = false;
    await withRunLock(runId, async () => {
      thirdAcquired = true;
    });
    expect(thirdAcquired).toBe(true);
  }, 20000);

  it("deux runId différents ne se bloquent jamais mutuellement", async () => {
    const runA = randomUUID();
    const runB = randomUUID();
    let bothRan = false;
    await withRunLock(runA, async () => {
      await withRunLock(runB, async () => {
        bothRan = true;
      });
    });
    expect(bothRan).toBe(true);
  }, 20000);

  it("le lock est relâché même si la fonction lève une erreur (pas de deadlock résiduel)", async () => {
    const runId = randomUUID();
    await expect(
      withRunLock(runId, async () => {
        throw new Error("échec simulé pendant le traitement");
      }),
    ).rejects.toThrow("échec simulé");

    // Le lock doit être libre malgré l'erreur.
    let reacquired = false;
    await withRunLock(runId, async () => {
      reacquired = true;
    });
    expect(reacquired).toBe(true);
  }, 20000);
});
