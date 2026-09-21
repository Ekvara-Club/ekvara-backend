import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import {
  LEGACY_AUTH_COOKIE_NAME,
  type AppContext,
  authCookieNameFor,
  buildAuthCookieOptions,
  buildLogoutCookieOptions,
  resolveAppContext,
} from "./auth.cookie";
import { InvitationsService } from "../invitations/invitations.service";
import { ValidateInvitationDto } from "../invitations/dto/validate-invitation.dto";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly invitationsService: InvitationsService,
  ) {}

  // Public, sans authentification (voir ticket §"VALIDATION PUBLIQUE DU
  // CODE") : throttlé comme register/login pour limiter le bruteforce sur un
  // format de code court, malgré son entropie élevée (voir
  // invitation-code.util.ts).
  @Post("invitations/validate")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  validateInvitation(@Body() dto: ValidateInvitationDto) {
    return this.invitationsService.validate(dto.code);
  }

  @Post("register")
  @UseGuards(ThrottlerGuard)
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Contexte validé AVANT toute écriture : un en-tête invalide ne crée rien.
    const context = resolveAppContext(req);
    const { athlete, token } = await this.authService.register(dto);
    this.setAuthCookie(res, context, token);
    return athlete;
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const context = resolveAppContext(req);
    const { athlete, token } = await this.authService.login(dto);
    this.setAuthCookie(res, context, token);
    return athlete;
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // N'efface QUE la session de l'application appelante : se déconnecter
    // côté athlète ne doit pas fermer la session coach (et inversement).
    // Un JWT copié avant logout reste cryptographiquement valide jusqu'à
    // expiration : volontairement pas de blacklist/révocation pour ce MVP.
    const context = resolveAppContext(req);
    res.clearCookie(authCookieNameFor(context), buildLogoutCookieOptions());
    // Nettoyage de l'ancien cookie partagé, inerte depuis la séparation.
    res.clearCookie(LEGACY_AUTH_COOKIE_NAME, buildLogoutCookieOptions());
    return { success: true };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  getMe(@Req() req: Request) {
    return this.authService.getMe(req.user!.athleteId);
  }

  private setAuthCookie(res: Response, context: AppContext, token: string): void {
    const maxAge = this.authService.getTokenRemainingMs(token);
    res.cookie(authCookieNameFor(context), token, buildAuthCookieOptions(maxAge));
  }
}
