import { ForbiddenException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async deleteUser(userId: number, mnemonic: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mnemonicHash: true },
    });

    const hash = user?.mnemonicHash ?? '$2b$10$invalidhashpaddingtomatchcost000000000000000000000000000';
    const valid = await bcrypt.compare(mnemonic, hash);
    if (!user || !valid) throw new ForbiddenException('Invalid recovery phrase');

    await this.prisma.user.delete({ where: { id: userId } });
  }
}
