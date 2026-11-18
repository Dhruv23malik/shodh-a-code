import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ContestStatus, OrgRole } from '../core/types';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateOrgDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @Matches(SLUG_RE, { message: 'slug must be lowercase letters, digits and hyphens' })
  slug!: string;
}

export class AddMemberDto {
  @IsUUID()
  userId!: string;

  @IsEnum(['organizer', 'participant'] as const)
  role!: OrgRole;
}

export class CreateContestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title!: string;

  @IsString()
  @Matches(SLUG_RE, { message: 'slug must be lowercase letters, digits and hyphens' })
  slug!: string;

  @IsDateString()
  opensAt!: string;

  @IsDateString()
  closesAt!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  penaltyPerWrong?: number;
}

export class UpdateContestDto {
  @IsEnum(['draft', 'open', 'closed'] as const)
  status!: ContestStatus;
}

export class TestCaseDto {
  @IsInt()
  @Min(0)
  position!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  input!: string;

  @IsString()
  expectedOutput!: string;

  @IsOptional()
  @IsBoolean()
  isHidden?: boolean;
}

export class CreateProblemDto {
  @IsString()
  @Matches(SLUG_RE, { message: 'slug must be lowercase letters, digits and hyphens' })
  slug!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  statement?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  timeLimitMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  memoryMb?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TestCaseDto)
  testCases!: TestCaseDto[];
}

export class CreateVersionDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TestCaseDto)
  testCases!: TestCaseDto[];
}

export class CreateSubmissionDto {
  @IsUUID()
  problemId!: string;

  @IsString()
  @MinLength(1)
  code!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  language?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey!: string;

  @IsOptional()
  @IsObject()
  runtimeConfig?: Record<string, unknown>;
}

export class RejudgeDto {
  @IsUUID()
  problemVersionId!: string;

  @IsUUID()
  testSuiteId!: string;
}
