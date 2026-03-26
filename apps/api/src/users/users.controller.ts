import { Body, Controller, Delete, HttpCode, HttpStatus, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { UsersService } from './users.service';

interface AuthenticatedRequest extends Request {
  user: { id: number; username: string };
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @UseGuards(JwtAuthGuard)
  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteMe(@Req() req: AuthenticatedRequest, @Body() dto: DeleteAccountDto) {
    return this.usersService.deleteUser(req.user.id, dto.mnemonic);
  }
}
