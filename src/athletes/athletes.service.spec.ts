import { Test, TestingModule } from '@nestjs/testing';
import { AthletesService } from './athletes.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AthletesService', () => {
  let service: AthletesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AthletesService, { provide: PrismaService, useValue: {} }],
    }).compile();

    service = module.get<AthletesService>(AthletesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
