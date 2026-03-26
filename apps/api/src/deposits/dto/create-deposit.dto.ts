import { IsInt, Max, Min } from 'class-validator';

export class CreateDepositDto {
  @IsInt()
  @Min(1000)
  @Max(100000000)
  amountSats!: number;
}
