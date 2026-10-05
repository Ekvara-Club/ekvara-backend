import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import request = require("supertest");
import { CoachMetricScalesController } from "./coach-metric-scales.controller";
import { MetricsService } from "../metrics/metrics.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CoachGuard } from "../auth/coach.guard";
import { authCookieHeader, signTestToken, testJwtModule } from "../test-utils/auth-test.helper";

describe("GET/PUT /coach/metric-scales (HTTP)", () => {
  let app: INestApplication;
  const service = { getClubScales: jest.fn(), saveClubScales: jest.fn() };
  const COACH_ID = "c0ffee00-0000-4000-8000-000000000001";
  const METRIC_ID = "d1e1d1e1-1111-4111-8111-111111111111";
  const coachCookie = () => authCookieHeader(signTestToken({ sub: "u-coach", coachId: COACH_ID }));
  const athleteCookie = () => authCookieHeader(signTestToken({ sub: "u-athlete", athleteId: "a-1" }));

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [testJwtModule()],
      controllers: [CoachMetricScalesController],
      providers: [{ provide: MetricsService, useValue: service }, JwtAuthGuard, CoachGuard],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.resetAllMocks();
  });

  it("athlète -> 403 (lecture comme écriture)", async () => {
    await request(app.getHttpServer()).get("/coach/metric-scales").set("Cookie", athleteCookie()).expect(403);
    await request(app.getHttpServer()).put("/coach/metric-scales").set("Cookie", athleteCookie()).send({ scales: [] }).expect(403);
    expect(service.saveClubScales).not.toHaveBeenCalled();
  });

  it.each([
    ["valeur non numérique", [{ metricTypeId: METRIC_ID, scoreZero: "600", scoreHundred: 250 }]],
    ["capacité non UUID", [{ metricTypeId: "x", scoreZero: 600, scoreHundred: 250 }]],
    ["capacité en double", [
      { metricTypeId: METRIC_ID, scoreZero: 600, scoreHundred: 250 },
      { metricTypeId: METRIC_ID, scoreZero: 500, scoreHundred: 300 },
    ]],
  ])("%s -> 400", async (_label, scales) => {
    await request(app.getHttpServer()).put("/coach/metric-scales").set("Cookie", coachCookie()).send({ scales }).expect(400);
    expect(service.saveClubScales).not.toHaveBeenCalled();
  });

  it("coach -> barème enregistré pour SON club (coach issu du JWT), null accepté pour revenir au défaut", async () => {
    service.saveClubScales.mockResolvedValue({ scales: [] });
    const scales = [{ metricTypeId: METRIC_ID, scoreZero: null, scoreHundred: null }];

    await request(app.getHttpServer()).put("/coach/metric-scales").set("Cookie", coachCookie()).send({ scales }).expect(200);

    expect(service.saveClubScales).toHaveBeenCalledWith(COACH_ID, "u-coach", scales);
  });
});
