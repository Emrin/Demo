import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bip39 from 'bip39';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RecoverDto } from './dto/recover.dto';
import { SignupDto } from './dto/signup.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
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

    return { access_token: this.jwt.sign({ sub: user.id, username: user.username, confirmed: true }) };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    return {
      access_token: this.jwt.sign({ sub: user.id, username: user.username, confirmed: user.mnemonicConfirmed }),
    };
  }
}
