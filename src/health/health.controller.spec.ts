import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request = require("supertest");
import { HealthController } from "./health.controller";
import { PrismaService } from "../prisma/prisma.service";

describe("GET /health", () => {
  let app: INestApplication;
  const prisma = { $queryRaw: jest.fn() };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.resetAllMocks();
  });

  it("base joignable -> 200, sans authentification", async () => {
    prisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok", database: "ok" });
  });

  it("base injoignable -> 503, jamais le message Postgres brut", async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432 password authentication failed for user "postgres"'));
    const res = await request(app.getHttpServer()).get("/health").expect(503);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|postgres/);
  });
});
