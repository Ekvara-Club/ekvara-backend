import type { AdminContext } from "./admin-session";

declare global {
  namespace Express {
    interface Request {
      // Renseigné uniquement par AdminGuard (routes /admin/*).
      admin?: AdminContext;
    }
  }
}

export {};
