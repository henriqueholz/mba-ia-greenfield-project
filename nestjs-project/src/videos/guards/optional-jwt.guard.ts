import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../../auth/auth.constants';
import type { JwtPayload } from '../../auth/auth.types';

/**
 * Populates `request.user` when a valid Bearer token is present, but never
 * rejects — used on public read endpoints so an owner can still access their
 * own non-ready videos while anonymous viewers get the ready ones.
 */
@Injectable()
export class OptionalJwtGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith(BEARER_PREFIX)) {
      try {
        request.user = await this.jwtService.verifyAsync<JwtPayload>(
          authHeader.slice(BEARER_PREFIX.length),
        );
      } catch {
        // Invalid/expired token → treat as anonymous.
      }
    }
    return true;
  }
}
