import { JwtPayload } from "./jwt-payload.interface";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export {};
