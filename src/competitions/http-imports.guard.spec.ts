import { NotFoundException } from "@nestjs/common";
import { HttpImportsGuard } from "./http-imports.guard";

describe("HttpImportsGuard", () => {
  const original = process.env.ALLOW_HTTP_IMPORTS;
  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_HTTP_IMPORTS;
    else process.env.ALLOW_HTTP_IMPORTS = original;
  });

  it("fermé par défaut : 404 (la route n'est pas révélée)", () => {
    delete process.env.ALLOW_HTTP_IMPORTS;
    expect(() => new HttpImportsGuard().canActivate()).toThrow(NotFoundException);
  });

  it("ALLOW_HTTP_IMPORTS=true : ouvert (développement)", () => {
    process.env.ALLOW_HTTP_IMPORTS = "true";
    expect(new HttpImportsGuard().canActivate()).toBe(true);
  });
});
