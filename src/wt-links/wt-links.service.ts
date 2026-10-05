import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsRepository } from "../notifications/notifications.repository";
import { toNotificationRows } from "../notifications/notifications.util";
import {
  ATHLETE_RESOURCE,
  WT_PROFILE_LINK_CONFIRMED,
  WT_PROFILE_LINK_REJECTED,
  WT_PROFILE_LINK_REQUESTED,
  WT_PROFILE_RESOURCE,
} from "../notifications/notification.constants";
import { namesMatch, stripAccents } from "./wt-name-match";

export const WT_LINK_PENDING = "pending";
export const WT_LINK_CONFIRMED = "confirmed";

const MAX_SUGGESTIONS = 5;
const SUGGESTION_CANDIDATES = 200;

const EXTERNAL_SELECT = { id: true, display_name: true, country_code: true } as const;

type ExternalRow = { id: string; display_name: string; country_code: string | null };

function toExternalView(row: ExternalRow) {
  return { id: row.id, displayName: row.display_name, countryCode: row.country_code };
}

function fullName(user: { prenom: string | null; nom: string | null }): string {
  return [user.prenom, user.nom].filter(Boolean).join(" ") || "Un athlète";
}

// Lien compte EKVARA <-> profil public World Taekwondo (athlete_wt_link).
// L'athlète réclame, son coach confirme ou refuse : jamais de lien posé sur
// la seule foi d'un nom. Chaque étape notifie l'autre partie, dans la même
// transaction que l'écriture (tout ou rien).
@Injectable()
export class WtLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsRepository,
  ) {}

  // Vue athlète : son lien (en attente ou confirmé) ou, sans lien, des
  // suggestions de profils portant son nom. Un profil déjà confirmé pour un
  // AUTRE compte n'est jamais suggéré.
  async getForAthlete(athleteId: string) {
    const athlete = await this.prisma.athlete.findUnique({
      where: { id: athleteId },
      select: {
        app_user: { select: { prenom: true, nom: true } },
        wt_link: { select: { status: true, requested_at: true, decided_at: true, external_athlete: { select: EXTERNAL_SELECT } } },
      },
    });
    if (!athlete) throw new NotFoundException(`Athlete ${athleteId} introuvable`);

    if (athlete.wt_link) {
      const { status, requested_at, decided_at, external_athlete } = athlete.wt_link;
      return {
        link: { status, requestedAt: requested_at, decidedAt: decided_at, externalAthlete: toExternalView(external_athlete) },
        suggestions: [],
      };
    }
    return { link: null, suggestions: await this.suggest(athleteId, athlete.app_user) };
  }

  private async suggest(athleteId: string, user: { prenom: string | null; nom: string | null }) {
    const lastName = user.nom?.trim();
    if (!lastName || !user.prenom?.trim()) return [];

    // Pré-filtre SQL sur le nom de famille (sans accents : WT les omet),
    // puis comparaison mot à mot en mémoire.
    const candidates = await this.prisma.external_athlete.findMany({
      where: {
        display_name: { contains: stripAccents(lastName), mode: "insensitive" },
        athlete_links: { none: { status: WT_LINK_CONFIRMED, athlete_id: { not: athleteId } } },
      },
      select: EXTERNAL_SELECT,
      take: SUGGESTION_CANDIDATES,
    });
    return candidates
      .filter((c) => namesMatch(fullName(user), c.display_name))
      .sort((a, b) => Number(b.country_code === "FRA") - Number(a.country_code === "FRA") || a.display_name.localeCompare(b.display_name))
      .slice(0, MAX_SUGGESTIONS)
      .map(toExternalView);
  }

  // Demande (ou remplace la demande) de lien : toujours "pending" jusqu'à la
  // décision du coach. Redemander le même profil ne change rien et ne
  // notifie personne (idempotent).
  async request(athleteId: string, actorUserId: string, externalAthleteId: string) {
    await this.prisma.$transaction(async (tx) => {
      const external = await tx.external_athlete.findUnique({ where: { id: externalAthleteId }, select: EXTERNAL_SELECT });
      if (!external) throw new NotFoundException("Profil World Taekwondo introuvable");

      const takenElsewhere = await tx.athlete_wt_link.findFirst({
        where: { external_athlete_id: externalAthleteId, status: WT_LINK_CONFIRMED, athlete_id: { not: athleteId } },
        select: { id: true },
      });
      if (takenElsewhere) throw new ConflictException("Ce profil World Taekwondo est déjà relié à un autre compte.");

      const current = await tx.athlete_wt_link.findUnique({ where: { athlete_id: athleteId }, select: { external_athlete_id: true } });
      if (current?.external_athlete_id === externalAthleteId) return;

      await tx.athlete_wt_link.upsert({
        where: { athlete_id: athleteId },
        create: { athlete_id: athleteId, external_athlete_id: externalAthleteId, status: WT_LINK_PENDING },
        update: {
          external_athlete_id: externalAthleteId,
          status: WT_LINK_PENDING,
          requested_at: new Date(),
          decided_at: null,
          decided_by_user_id: null,
        },
      });

      const athlete = await tx.athlete.findUniqueOrThrow({
        where: { id: athleteId },
        select: {
          app_user: { select: { prenom: true, nom: true } },
          coach_athlete: { select: { coach_profile: { select: { user_id: true } } } },
        },
      });
      const name = fullName(athlete.app_user);
      const country = external.country_code ? ` (${external.country_code})` : "";
      await this.notifications.createMany(
        tx,
        toNotificationRows([...new Set(athlete.coach_athlete.map((l) => l.coach_profile.user_id))], {
          actorUserId,
          context: "COACH",
          type: WT_PROFILE_LINK_REQUESTED,
          title: `${name} veut relier son profil World Taekwondo`,
          message: `${name} indique être « ${external.display_name}${country} » sur World Taekwondo. Confirme ou refuse depuis sa fiche.`,
          resourceType: ATHLETE_RESOURCE,
          resourceId: athleteId,
        }),
      );
    });
    return this.getForAthlete(athleteId);
  }

  // Retrait par l'athlète (demande en attente ou lien confirmé).
  async unlink(athleteId: string) {
    await this.prisma.athlete_wt_link.deleteMany({ where: { athlete_id: athleteId } });
    return this.getForAthlete(athleteId);
  }

  // Décision du coach (CoachAthleteAccessGuard a vérifié qu'il suit cet
  // athlète). Seule une demande EN ATTENTE peut être tranchée.
  async decide(athleteId: string, actorUserId: string, decision: "confirm" | "reject") {
    await this.prisma.$transaction(async (tx) => {
      const link = await tx.athlete_wt_link.findUnique({
        where: { athlete_id: athleteId },
        select: { id: true, status: true, external_athlete: { select: EXTERNAL_SELECT } },
      });
      if (!link || link.status !== WT_LINK_PENDING) {
        throw new NotFoundException("Aucune demande de lien World Taekwondo en attente pour cet athlète");
      }

      const recipient = await tx.athlete.findUniqueOrThrow({ where: { id: athleteId }, select: { user_id: true } });
      const profile = link.external_athlete.display_name;

      if (decision === "confirm") {
        const takenElsewhere = await tx.athlete_wt_link.findFirst({
          where: { external_athlete_id: link.external_athlete.id, status: WT_LINK_CONFIRMED, athlete_id: { not: athleteId } },
          select: { id: true },
        });
        if (takenElsewhere) throw new ConflictException("Ce profil World Taekwondo est déjà relié à un autre compte.");

        await tx.athlete_wt_link.update({
          where: { id: link.id },
          data: { status: WT_LINK_CONFIRMED, decided_at: new Date(), decided_by_user_id: actorUserId },
        });
      } else {
        await tx.athlete_wt_link.delete({ where: { id: link.id } });
      }

      await this.notifications.createMany(
        tx,
        toNotificationRows([recipient.user_id], {
          actorUserId,
          context: "ATHLETE",
          type: decision === "confirm" ? WT_PROFILE_LINK_CONFIRMED : WT_PROFILE_LINK_REJECTED,
          title: decision === "confirm" ? "Profil World Taekwondo relié" : "Profil World Taekwondo non confirmé",
          message:
            decision === "confirm"
              ? `Ton coach a confirmé ton profil « ${profile} ». Ton palmarès international est dans ton Passeport.`
              : `Ton coach n'a pas confirmé le profil « ${profile} ». Tu peux en choisir un autre depuis ton Passeport.`,
          resourceType: WT_PROFILE_RESOURCE,
          resourceId: null,
        }),
      );
    });
  }
}
