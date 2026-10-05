import { Body, Controller, ForbiddenException, Get, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { AuthService, authCookie, cookieOptions, type AuthRequest } from "./auth.service";
import { LoginDto, RegisterDto } from "./auth.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  @Post("login") login(@Body() input: LoginDto, @Res({ passthrough: true }) response: Response) { return this.auth.login(input, response); }
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post("register") register(@Body() input: RegisterDto, @Res({ passthrough: true }) response: Response) { return this.auth.register(input, response); }
  @Get("session") async session(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    try { const user = await this.auth.authenticate(request, false); return { user: user ? await this.auth.userView(user) : null }; }
    catch (error) {
      if (!(error instanceof UnauthorizedException || error instanceof ForbiddenException)) throw error;
      response.clearCookie(authCookie, cookieOptions()); return { user: null };
    }
  }
  @Post("logout") logout(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) { return this.auth.logout(request, response); }
}
