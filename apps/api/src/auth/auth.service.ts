import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bip39 from 'bip39';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RecoverDto } from './dto/recover.dto';
import { SignupDto } from './dto/signup.dto';

const TOKEN_REVOCATION_TTL = 7 * 24 * 60 * 60; // 7 days — matches JWT max lifetime

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async signup(dto: SignupDto) {
    const existing = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (existing) throw new BadRequestException('Username already taken');

    const mnemonic = bip39.generateMnemonic(); // 128-bit entropy = 12 words
    const [passwordHash, mnemonicHash] = await Promise.all([
      bcrypt.hash(dto.password, 10),
      bcrypt.hash(mnemonic, 10),
    ]);

    const user = await this.prisma.user.create({
      data: { username: dto.username, passwordHash, mnemonicHash },
    });

    return {
      // confirmed: false — app is locked until recovery setup is completed
      access_token: this.jwt.sign({ sub: user.id, username: user.username, confirmed: false }),
      mnemonic: mnemonic.split(' '),
    };
  }

  async confirmMnemonic(userId: number) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { mnemonicConfirmed: true },
      select: { username: true },
    });
    return {
      access_token: this.jwt.sign({ sub: userId, username: user.username, confirmed: true }),
    };
  }

  async recover(dto: RecoverDto) {
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    // Constant-time path to prevent user enumeration via timing
    const hash = user?.mnemonicHash ?? '$2b$10$invalidhashpaddingtomatchcost000000000000000000000000000';
    const valid = await bcrypt.compare(dto.mnemonic, hash);
    if (!user || !valid) throw new UnauthorizedException('Invalid username or recovery phrase');

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Revoke all sessions issued before this moment
    await this.redis.set(
      `user:${user.id}:revoked_at`,
      Math.floor(Date.now() / 1000) - 1,
      'EX',
      TOKEN_REVOCATION_TTL,
    );

    return { access_token: this.jwt.sign({ sub: user.id, username: user.username, confirmed: true }) };
  }

  async logout(userId: number, tokenIat: number): Promise<void> {
    await this.redis.set(`user:${userId}:revoked_at`, tokenIat, 'EX', TOKEN_REVOCATION_TTL);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const access_token = this.jwt.sign({ sub: user.id, username: user.username, confirmed: user.mnemonicConfirmed });

    if (!user.mnemonicConfirmed) {
      // The previous mnemonic was never confirmed — the user never wrote it down, so the
      // stored hash is useless. Generate a fresh one so they can complete setup now.
      const mnemonic = bip39.generateMnemonic();
      const mnemonicHash = await bcrypt.hash(mnemonic, 10);
      await this.prisma.user.update({ where: { id: user.id }, data: { mnemonicHash } });
      return { access_token, mnemonic: mnemonic.split(' ') };
    }

    return { access_token };
  }
}
