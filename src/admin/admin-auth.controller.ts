import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { AdminAuthService } from "./admin-auth.service";
import { AdminGuard } from "./admin.guard";
import { ADMIN_COOKIE_NAME, buildAdminCookieOptions, buildAdminLogoutCookieOptions } from "./admin-session";
import { AdminLoginDto } from "./dto/admin-login.dto";

// Authentification du portail EkvaraAdmin, indépendante de /auth (Athlete,
// Coach). login est la SEULE route /admin/* sans AdminGuard (throttlée) ;
// session et logout exigent une session admin valide, et logout (méthode
// non-sûre) le jeton CSRF de cette session.
@Controller("admin/auth")
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  async login(@Body() dto: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    const { token, session } = await this.adminAuthService.login(dto);
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
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Comme /auth/logout : pas de révocation serveur du JWT (durée courte,
    // 8 h) ; la révocation immédiate passe par ADMIN_USER_IDS.
    this.adminAuthService.recordLogout(req.admin!);
    res.clearCookie(ADMIN_COOKIE_NAME, buildAdminLogoutCookieOptions());
    return { success: true };
  }
}
