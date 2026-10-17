import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AdminAuthService, AdminLoginThrottledException } from "./admin-auth.service";
import { AdminGuard } from "./admin.guard";
import { ADMIN_COOKIE_NAME, buildAdminCookieOptions, buildAdminLogoutCookieOptions } from "./admin-session";
import { AdminLoginDto } from "./dto/admin-login.dto";

// Authentification du portail EkvaraAdmin, indépendante de /auth (Athlete,
// Coach). login est la SEULE route /admin/* sans AdminGuard (tentatives
// limitées par AdminLoginThrottle, compteurs partagés en base) ;
// session et logout exigent une session admin valide, et logout (méthode
// non-sûre) le jeton CSRF de cette session.
@Controller("admin/auth")
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  // req.ip suit la configuration "trust proxy" (TRUST_PROXY) : sur Vercel,
  // l'adresse du client transmise par la plateforme ; sans elle, l'adresse
  // du proxy (limite par IP alors commune à tous — la limite par compte
  // reste effective).
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: AdminLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    let result;
    try {
      result = await this.adminAuthService.login(dto, req.ip ?? "unknown");
    } catch (error) {
      if (error instanceof AdminLoginThrottledException) res.setHeader("Retry-After", String(error.retryAfterSeconds));
      throw error;
    }
    const { token, session } = result;
    res.cookie(ADMIN_COOKIE_NAME, token, buildAdminCookieOptions());
    return session;
  }

  @Get("session")
  @UseGuards(AdminGuard)
  session(@Req() req: Request) {
    return this.adminAuthService.getSession(req.admin!);
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Révocation serveur de la session (admin_session) : le JWT, et toute
    // copie, est refusé dès la requête suivante. /auth/logout (Athlete/Coach)
    // n'est pas concerné.
    await this.adminAuthService.logout(req.admin!);
    res.clearCookie(ADMIN_COOKIE_NAME, buildAdminLogoutCookieOptions());
    return { success: true };
  }
}
