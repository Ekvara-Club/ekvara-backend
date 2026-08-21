import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { PrismaService } from "../prisma/prisma.service";
import { AthletesService } from "../athletes/athletes.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { JwtPayload } from "./jwt-payload.interface";

const INVALID_CREDENTIALS_MESSAGE = "Email ou mot de passe incorrect";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly athletesService: AthletesService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    // Réutilise AthletesService.create (transaction app_user + athlete déjà
    // existante) plutôt que de dupliquer cette logique ici.
    const athlete = await this.athletesService.create(
      { email, nom: dto.nom, prenom: dto.prenom },
      passwordHash,
    );

    const token = this.signToken({ sub: athlete.app_user.id, athleteId: athlete.id });
    return { athlete, token };
  }

  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();

    const user = await this.prisma.app_user.findUnique({
      where: { email },
      include: { athlete: true },
    });

    // Même exception, même message, que l'utilisateur soit absent ou que le
    // mot de passe soit incorrect : ne jamais permettre l'énumération des emails.
    if (!user?.password_hash || !user.athlete) {
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

    const token = this.signToken({ sub: user.id, athleteId: user.athlete.id });
    const athlete = await this.athletesService.findOne(user.athlete.id);
    return { athlete, token };
  }

  getMe(athleteId: string) {
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
