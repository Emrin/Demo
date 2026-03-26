import { IsString, MinLength } from 'class-validator';

export class RecoverDto {
  @IsString()
  username!: string;

  @IsString()
  mnemonic!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
