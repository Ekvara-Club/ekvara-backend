import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { AUTH_COOKIE_NAME, buildAuthCookieOptions, buildLogoutCookieOptions } from "./auth.cookie";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @UseGuards(ThrottlerGuard)
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const { athlete, token } = await this.authService.register(dto);
    this.setAuthCookie(res, token);
    return athlete;
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const { athlete, token } = await this.authService.login(dto);
    this.setAuthCookie(res, token);
    return athlete;
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    // Efface le cookie côté navigateur. Un JWT copié avant logout reste
    // cryptographiquement valide jusqu'à expiration : volontairement pas de
    // blacklist/révocation pour ce MVP.
    res.clearCookie(AUTH_COOKIE_NAME, buildLogoutCookieOptions());
    return { success: true };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  getMe(@Req() req: Request) {
    return this.authService.getMe(req.user!.athleteId);
  }

  private setAuthCookie(res: Response, token: string): void {
    const maxAge = this.authService.getTokenRemainingMs(token);
    res.cookie(AUTH_COOKIE_NAME, token, buildAuthCookieOptions(maxAge));
  }
}
