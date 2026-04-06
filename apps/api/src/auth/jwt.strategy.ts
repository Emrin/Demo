import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET!,
    });
  }

  async validate(payload: { sub: number; username: string; confirmed: boolean; iat: number }) {
    const revokedAt = await this.redis.get(`user:${payload.sub}:revoked_at`);
    if (revokedAt && payload.iat <= parseInt(revokedAt, 10)) {
      throw new UnauthorizedException('Token has been revoked');
    }
    return { id: payload.sub, username: payload.username, confirmed: payload.confirmed, iat: payload.iat };
  }
}
