import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RecoverDto } from './dto/recover.dto';
import { SignupDto } from './dto/signup.dto';

interface AuthenticatedRequest extends Request {
  user: { id: number; username: string };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('recover')
  recover(@Body() dto: RecoverDto) {
    return this.authService.recover(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('confirm-mnemonic')
  confirmMnemonic(@Req() req: AuthenticatedRequest) {
    return this.authService.confirmMnemonic(req.user.id);
  }
}
