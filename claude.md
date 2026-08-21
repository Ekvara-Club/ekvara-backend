Tu travailles sur le backend du projet Ekvara.

Lis d'abord entièrement le fichier `CLAUDE.md` à la racine du projet et respecte ses instructions.

## Objectif

Implémenter le premier flux métier fonctionnel du backend :

**Créer un athlète via `POST /athletes` et enregistrer correctement les données dans PostgreSQL avec Prisma.**

## Avant de coder

Inspecte impérativement l'existant :

- `package.json`
- `prisma.config.ts`
- `prisma/schema.prisma`
- `src/app.module.ts`
- le dossier `src/athletes/`
- le dossier `src/prisma/`
- la configuration actuelle de NestJS et Prisma

Ne suppose pas les noms des modèles Prisma.

Utilise exactement les modèles et champs réellement présents dans `schema.prisma`.

Ne recrée pas la base de données et ne supprime aucune donnée existante.

---

## 1. PrismaService

Vérifie que nous avons un `PrismaService` correctement intégré à NestJS.

La structure souhaitée est :

`src/prisma/prisma.service.ts`

et :

`src/prisma/prisma.module.ts`

Le module Prisma doit exporter `PrismaService` afin qu'il puisse être injecté dans les autres modules.

Adapte l'implémentation à la version de Prisma réellement installée dans le projet.

Ne copie pas aveuglément une ancienne configuration Prisma si elle n'est pas compatible avec la version actuelle.

---

## 2. Module Athletes

Vérifie/crée cette structure :

```text
src/athletes/
├── dto/
│   └── create-athlete.dto.ts
├── athletes.controller.ts
├── athletes.service.ts
└── athletes.module.ts
```

Ne crée pas de fichiers inutiles.

---

## 3. DTO

Créer `CreateAthleteDto`.

Le premier endpoint doit pouvoir recevoir :

- email
- nom
- prenom
- clubId optionnel
- categorieAge optionnel
- genre optionnel
- grade optionnel
- dateNaissance optionnelle
- niveauSportif optionnel

Utilise des types TypeScript propres.

Si les packages de validation NestJS (`class-validator`, `class-transformer`) sont déjà présents, utilise-les correctement.

S'ils ne sont pas installés, ne rajoute pas de dépendances inutilement juste pour cette première étape sans m'en informer.

---

## 4. POST /athletes

Créer :

`POST /athletes`

Le endpoint doit créer les données correspondant à l'utilisateur et à l'athlète en respectant le modèle Prisma existant.

La création doit être **transactionnelle**.

Cela signifie que si la création de l'athlète échoue après la création de l'utilisateur, l'utilisateur ne doit pas rester seul dans la base.

Utilise donc une transaction Prisma.

Logique :

```text
POST /athletes
      ↓
transaction
      ↓
création app_user
      ↓
création athlete lié au user
      ↓
commit
```

Si une relation vers un club est fournie via `clubId`, utilise-la correctement.

---

## 5. Exemple de requête attendue

L'API doit pouvoir accepter quelque chose conceptuellement équivalent à :

```json
{
  "email": "athlete@test.fr",
  "nom": "Athlete",
  "prenom": "Test",
  "dateNaissance": "2004-06-15",
  "genre": "homme",
  "categorieAge": "senior",
  "grade": "1er dan",
  "niveauSportif": "national"
}
```

Adapte les noms uniquement si le `schema.prisma` existant l'exige.

---

## 6. Réponse API

Retourne l'athlète créé avec les informations utilisateur nécessaires.

Ne retourne jamais :

- `password_hash`
- secrets
- données sensibles inutiles

Même si ces champs existent dans `app_user`.

---

## 7. Gestion des erreurs

Gérer proprement au minimum :

- email déjà utilisé ;
- club inexistant lorsqu'un `clubId` est fourni ;
- données obligatoires manquantes ;
- date invalide ;
- erreur Prisma inattendue.

Utilise les exceptions HTTP NestJS appropriées.

Ne renvoie pas les erreurs internes Prisma directement au frontend.

---

## 8. AppModule

Vérifie que les modules nécessaires sont correctement importés dans `AppModule`.

Ne modifie pas l'architecture générale du projet si ce n'est pas nécessaire.

---

## 9. Ne PAS faire

Pour cette tâche, ne développe PAS :

- authentification ;
- login ;
- JWT ;
- compétitions ;
- poids ;
- objectifs ;
- exercices ;
- frontend ;
- système coach ;
- endpoints supplémentaires non demandés.

Nous voulons uniquement obtenir un premier flux propre :

**HTTP → NestJS → Prisma → PostgreSQL**

---

## 10. Vérification

À la fin :

1. lance les vérifications TypeScript/build disponibles ;
2. corrige les erreurs provoquées par tes modifications ;
3. vérifie que NestJS démarre ;
4. indique-moi précisément les fichiers créés ou modifiés ;
5. donne-moi ensuite la requête exacte à utiliser dans Postman pour tester `POST /athletes`.

Ne lance aucune migration destructive.

Ne modifie pas `schema.prisma` sauf si une modification est réellement indispensable au fonctionnement de ce flux. Si tu identifies un problème de modèle de données, explique-le-moi avant d'effectuer une modification structurelle importante.
