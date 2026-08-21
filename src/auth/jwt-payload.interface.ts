// Payload JWT volontairement minimal : uniquement ce qui est nécessaire pour
// identifier l'utilisateur et vérifier l'ownership. Le reste (email, nom,
// club...) peut changer et doit être lu en base via GET /auth/me, jamais
// dupliqué dans le token.
export interface JwtPayload {
  sub: string; // app_user.id
  athleteId: string; // athlete.id
}
