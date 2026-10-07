import { NotFoundException } from "@nestjs/common";
import { HttpImportsGuard } from "./http-imports.guard";

describe("HttpImportsGuard", () => {
  const original = process.env.ALLOW_HTTP_IMPORTS;
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_HTTP_IMPORTS;
    else process.env.ALLOW_HTTP_IMPORTS = original;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("fermé par défaut : 404 (la route n'est pas révélée)", () => {
    delete process.env.ALLOW_HTTP_IMPORTS;
    expect(() => new HttpImportsGuard().canActivate()).toThrow(NotFoundException);
  });

  it("ALLOW_HTTP_IMPORTS=true : ouvert (développement)", () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_HTTP_IMPORTS = "true";
    expect(new HttpImportsGuard().canActivate()).toBe(true);
  });

  it("production : 404 même avec ALLOW_HTTP_IMPORTS=true (.env de dev recopié)", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_HTTP_IMPORTS = "true";
    expect(() => new HttpImportsGuard().canActivate()).toThrow(NotFoundException);
  });
});
