# Est-ce qu'EKVARA est prêt ? — liste de vérification du déploiement

Statut au 5 octobre 2026. ✅ = vérifié, ⬜ = à faire, ⚠️ = risque connu.

## A. Code (vérifié automatiquement)

- ✅ Backend : 1 459 tests (tests unitaires, HTTP, intégration PostgreSQL), build OK
  - ⚠️ `coach-metrics-dashboard.spec` échoue parfois en suite complète (DB partagée), passe seul
- ✅ App athlète : 207 tests, build OK, chaque page chargée à la demande
- ✅ App coach : 92 tests, build OK
- ✅ Migrations : toutes additives, aucune destructive
- ✅ CORS, proxy, cookies Secure configurables par `.env` (CORS obligatoire en production)
- ✅ Imports de compétitions fermés sur Internet (CLI à la place)
- ✅ Création du premier coach : `npm run create:coach`
- ✅ `/health` pour vérifier API + base
- ⬜ Pousser le backend sur GitLab (`develop`)
- ⬜ Créer un dépôt GitLab pour l'app coach (aucun remote aujourd'hui) — non bloquant pour le Pi

## B. Infrastructure (Pi)

- ⬜ Raspberry Pi OS 64 bits à jour, Node 22, PostgreSQL, pm2, Caddy
- ⬜ Domaine acheté sur Cloudflare
- ⬜ Tunnel Cloudflare : app / coach / api
- ⬜ `.env` de production (JWT_SECRET neuf, CORS_ORIGINS, TRUST_PROXY)
- ⬜ `https://api.DOMAINE/health` → `{"status":"ok","database":"ok"}`
- ⬜ Sauvegarde nocturne active + première copie hors du Pi
- ⬜ Test de restauration d'une sauvegarde (sur une base de test)

## C. Parcours réels (à faire ensemble, sur la prod une fois en ligne)

Coach :
- ⬜ Connexion coach / déconnexion
- ⬜ Créer un groupe, créer une invitation athlète
- ⬜ Créer une séance unique pour le groupe
- ⬜ Créer une séance récurrente (ex. tous les mercredis, 1 mois) → bon nombre de séances, bonnes heures
- ⬜ Annuler la suite d'une série
- ⬜ Préparer une compétition pour un athlète
- ⬜ Voir l'état d'un athlète (badge dans la liste, fiche, « À surveiller ») et ouvrir sa fiche depuis la notification
- ⬜ Demande de profil World Taekwondo : notification, « À surveiller », Confirmer puis Refuser (sur un autre athlète)

Athlète :
- ⬜ Inscription avec le code d'invitation → arrive connecté sur l'accueil
- ⬜ Accueil : les 5 cartes s'affichent ; compte neuf → « + Ajouter une pesée / un entraînement / une compétition » depuis les cartes vides
- ⬜ Activité : voit les séances du coach (dont la série), ajoute un entraînement
- ⬜ Notifications : « Nouvel entraînement récurrent », un seul message
- ⬜ Poids : ajouter une pesée
- ⬜ Objectifs, Progression, Exercices : pages chargées
- ⬜ Compétitions : catalogue, filtres, fiche ; s'inscrire à une compétition
- ⬜ Passeport : renseigner un résultat passé
- ⬜ Passeport « Mon état » : passer Blessé (précision + date de retour), puis revenir Actif
- ⬜ Passeport « Palmarès international » : suggestion ou recherche, « C'est moi », attente, puis palmarès après confirmation du coach
- ⬜ Sur téléphone (4G, hors Wi-Fi maison) : connexion + navigation

Sécurité :
- ⬜ `POST https://api.DOMAINE/competitions/import/fftda` → 404
- ⬜ Un athlète ne peut pas ouvrir l'app coach (refus propre)
- ⬜ Cookies : `Secure`, `HttpOnly` (outils développeur du navigateur)

## D. Décisions en attente

- ⚠️ Contraste du gris secondaire `ekvara-muted` (2,41:1, sous le minimum WCAG) — non bloquant
