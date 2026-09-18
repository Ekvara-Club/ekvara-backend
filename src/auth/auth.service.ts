import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { PrismaService } from "../prisma/prisma.service";
import { AthletesService, mapAthleteCreationError } from "../athletes/athletes.service";
import { InvitationsService } from "../invitations/invitations.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { JwtPayload } from "./jwt-payload.interface";

const INVALID_CREDENTIALS_MESSAGE = "Email ou mot de passe incorrect";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly athletesService: AthletesService,
    private readonly invitationsService: InvitationsService,
    private readonly jwtService: JwtService,
  ) {}

  // Transaction UNIQUE englobant : consommation de l'invitation, création
  // app_user + athlete (club_id dérivé de l'invitation, jamais du client),
  // rattachement coach_athlete au coach créateur de l'invitation, et
  // affectation de groupe optionnelle (voir ticket §"TRANSACTION REGISTER").
  // Toute erreur à n'importe quelle étape fait tout annuler (Prisma
  // $transaction rollback complet) : jamais un compte créé sans invitation
  // consommée, ni l'inverse (voir §"ROLLBACK SI CRÉATION ATHLETE ÉCHOUE").
  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    let athlete;
    try {
      athlete = await this.prisma.$transaction(async (tx) => {
        const invitation = await this.invitationsService.redeem(tx, dto.invitationCode);

        const created = await this.athletesService.createWithinTransaction(
          tx,
          { email, nom: dto.nom, prenom: dto.prenom, clubId: invitation.club_id },
          passwordHash,
        );

        // Le coach créateur de l'invitation suit automatiquement le nouvel
        // athlète (voir ticket §"RELATION COACH_ATHLETE") : le club représente
        // l'appartenance organisationnelle, coach_athlete le suivi opérationnel.
        await tx.coach_athlete.create({
          data: { coach_id: invitation.created_by_coach_id, athlete_id: created.id },
        });

        // Groupe optionnel (voir ticket §"INVITATION ET GROUPE") : jamais
        // obligatoire, l'athlète rejoint simplement le club sans groupe sinon.
        if (invitation.assigned_group_id) {
          await tx.coach_group_athlete.create({
            data: { group_id: invitation.assigned_group_id, athlete_id: created.id },
          });
        }

        return created;
      });
    } catch (error) {
      throw mapAthleteCreationError(error);
    }

    const token = this.signToken({ sub: athlete.app_user.id, athleteId: athlete.id });
    return { athlete, token };
  }

  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();

    const user = await this.prisma.app_user.findUnique({
      where: { email },
      include: { athlete: true, coach_profile: true },
    });

    // Même exception, même message, que l'utilisateur soit absent, que le mot
    // de passe soit incorrect, ou qu'il n'ait ni profil athlète ni profil
    // coach (compte orphelin) : ne jamais permettre l'énumération des emails.
    if (!user?.password_hash || (!user.athlete && !user.coach_profile)) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    let passwordValid: boolean;
    try {
      passwordValid = await argon2.verify(user.password_hash, dto.password);
    } catch {
      passwordValid = false;
    }

    if (!passwordValid) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    // Payload construit à partir des profils réellement présents : pas de
    // rôle enum, athleteId/coachId sont indépendamment peuplés (utilisateur
    // hybride = les deux à la fois).
    const payload: JwtPayload = { sub: user.id };
    if (user.athlete) {
      payload.athleteId = user.athlete.id;
    }
    if (user.coach_profile) {
      payload.coachId = user.coach_profile.id;
    }

    const token = this.signToken(payload);
    // Le corps de réponse reste le profil athlète pour ne pas casser le
    // frontend athlète existant (voir AuthMeResponse côté EkvaraFrontend, qui
    // attend la forme brute d'AthletesService.findOne au niveau racine). Un
    // coach-only reçoit `athlete: null` ; le frontend coach doit ensuite
    // appeler GET /coach/me pour récupérer son identité coach.
    const athlete = user.athlete ? await this.athletesService.findOne(user.athlete.id) : null;
    return { athlete, token };
  }

  // Même contrainte de compatibilité que login() : ne renvoie la forme brute
  // athlète que si un profil athlète existe sur le token, jamais un objet
  // reformé, pour ne pas casser AuthMeResponse côté frontend athlète.
  //
  // Un coach-only lève UnauthorizedException plutôt que de renvoyer `null` :
  // AuthMeResponse côté EkvaraFrontend appelle response.json() sans condition
  // sur tout 200, et NestJS envoie un corps VIDE (pas le JSON littéral
  // "null") pour un retour null — un `null` renvoyé ici planterait donc le
  // parsing JSON côté frontend au lieu d'être traité comme "pas de session".
  // 401 réutilise exactement le chemin déjà géré par getMe() côté frontend
  // (status 401 -> null), sans aucune modification frontend nécessaire.
  // L'identité coach se lit via GET /coach/me, jamais ici.
  getMe(athleteId?: string) {
    if (!athleteId) {
      throw new UnauthorizedException("Aucune session athlète");
    }
    return this.athletesService.findOne(athleteId);
  }

  signToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload);
  }

  // Durée de vie restante du token en ms, pour aligner le Max-Age du cookie
  // sur l'expiration réelle du JWT plutôt que de reparser JWT_EXPIRES_IN.
  getTokenRemainingMs(token: string): number {
    const decoded = this.jwtService.decode(token) as { exp?: number } | null;
    if (!decoded?.exp) {
      return 0;
    }
    return decoded.exp * 1000 - Date.now();
  }
}
