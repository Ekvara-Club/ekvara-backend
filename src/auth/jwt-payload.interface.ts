// Payload JWT volontairement minimal : uniquement ce qui est nécessaire pour
// identifier l'utilisateur et vérifier l'ownership. Le reste (email, nom,
// club...) peut changer et doit être lu en base via GET /auth/me, jamais
// dupliqué dans le token.
//
// athleteId / coachId sont indépendamment optionnels (pas de rôle enum) :
// un app_user peut posséder athlete, coach_profile, les deux (utilisateur
// hybride) ou aucun des deux tant qu'il n'a pas fini son onboarding. Le rôle
// effectif se lit par la présence de ces champs, jamais par une valeur
// "role". Voir AuthService.login pour la règle de peuplement.
export interface JwtPayload {
  sub: string; // app_user.id
  athleteId?: string; // athlete.id, si l'utilisateur a un profil athlète
  coachId?: string; // coach_profile.id, si l'utilisateur a un profil coach
}
