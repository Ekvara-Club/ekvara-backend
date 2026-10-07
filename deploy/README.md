# Déployer EKVARA sur le Raspberry Pi 5

Architecture : tout tourne sur le Pi, rien n'est ouvert sur la box.

```
Internet ─HTTPS─> Cloudflare ─tunnel─> cloudflared (Pi) ─> Caddy :8080 (Pi)
                                                          ├─ app.DOMAINE   -> /srv/ekvara/athlete (statique)
                                                          ├─ coach.DOMAINE -> /srv/ekvara/coach   (statique)
                                                          └─ api.DOMAINE   -> NestJS :3000 (pm2) -> PostgreSQL
```

Les trois adresses partagent le même domaine : les cookies de session
(`SameSite=lax`, `Secure`) fonctionnent sans changement.

Dans ce guide, remplace `ekvara.fr` par ton domaine et `pi` par ton
utilisateur sur le Pi.

---

## 1. Préparer le Pi (une seule fois)

Raspberry Pi OS **64 bits**. Idéalement un SSD USB plutôt que la carte SD
(la base y écrit en continu).

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git curl rsync postgresql
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
node -v   # v22.x
```

## 2. PostgreSQL : base et utilisateur dédiés

```bash
sudo -u postgres psql -c "CREATE USER ekvara WITH PASSWORD 'UN_MOT_DE_PASSE_LONG';"
sudo -u postgres psql -c "CREATE DATABASE ekvara OWNER ekvara;"
```

PostgreSQL n'écoute que sur localhost par défaut : ne change pas ça.

## 3. Backend

```bash
mkdir -p ~/ekvara && cd ~/ekvara
git clone https://gitlab.com/ekinfinity/<depot-backend>.git backend
cd backend && git checkout develop
cp .env.example .env
nano .env
```

`.env` de production (aucune autre variable) :

```
PORT=3000
NODE_ENV=production
DATABASE_URL="postgresql://ekvara:UN_MOT_DE_PASSE_LONG@localhost:5432/ekvara"
JWT_SECRET="<node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\">"
JWT_EXPIRES_IN="7d"
CORS_ORIGINS="https://app.ekvara.fr,https://coach.ekvara.fr"
TRUST_PROXY=loopback
```

- `JWT_SECRET` : **nouveau**, jamais celui de ton Mac.
- **Ne pas** mettre `ALLOW_HTTP_IMPORTS` (les imports se font en CLI).

```bash
npm ci
npm run build              # prisma generate + nest build
npm run migrate:deploy     # crée toutes les tables (base neuve)
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup    # suivre la commande affichée : relance au reboot
curl http://localhost:3000/health   # {"status":"ok","database":"ok"}
```

## 4. Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo mkdir -p /srv/ekvara/athlete /srv/ekvara/coach
sudo chown -R pi:pi /srv/ekvara
sudo cp ~/ekvara/backend/deploy/Caddyfile /etc/caddy/Caddyfile
echo 'EKVARA_DOMAIN=ekvara.fr' | sudo tee /etc/default/caddy
sudo systemctl edit caddy     # ajouter :  [Service]  EnvironmentFile=/etc/default/caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl restart caddy
```

## 5. Domaine + Cloudflare Tunnel

1. Acheter le domaine sur Cloudflare (Domain Registration) — il est
   directement géré par Cloudflare.
2. Sur le Pi :

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login                 # ouvre une URL : autoriser le domaine
cloudflared tunnel create ekvara         # note le TUNNEL_ID affiché
cloudflared tunnel route dns ekvara app.ekvara.fr
cloudflared tunnel route dns ekvara coach.ekvara.fr
cloudflared tunnel route dns ekvara api.ekvara.fr
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/
sudo cp ~/ekvara/backend/deploy/cloudflared-config.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml    # TUNNEL_ID + domaine
sudo cloudflared service install
curl https://api.ekvara.fr/health        # depuis n'importe où
```

## 6. Frontends (depuis ton Mac)

Activer la connexion SSH par clé vers le Pi (`ssh-copy-id pi@raspberrypi.local`),
puis :

```bash
cd ~/Dev/Ekvara/EkvaraBackend
EKVARA_DOMAIN=ekvara.fr PI=pi@raspberrypi.local ./deploy/publish-frontends.sh
```

Le script lance les tests, build avec `VITE_API_URL=https://api.ekvara.fr`
et copie les fichiers sur le Pi. Rien n'est publié si un test échoue.

## 7. Données de départ (base neuve)

Sur le Pi, dans `~/ekvara/backend` :

```bash
npm run seed:metrics          # capacités (endurance, force…) : indispensable
npm run seed:exercises
npm run import:competitions -- fftda
npm run import:competitions -- world-taekwondo --year=2026
npm run import:competitions -- world-taekwondo --year=2027
npm run import:competitions -- martial-events
npm run create:coach -- --email=coach@club.fr --prenom=Prénom --nom=Nom --club="Nom du club" --ville=Ville --pays=France
```

Le mot de passe du coach est demandé au clavier. Les athlètes s'inscrivent
ensuite avec un code d'invitation créé par ce coach.

### Mot de passe oublié

Pas d'envoi d'e-mail en V1 : sur demande de la personne, sur le Pi,

```bash
cd ~/ekvara/backend && npm run reset:password -- --email=personne@exemple.fr
```

Le nouveau mot de passe est saisi au clavier ; transmets-le à la personne.

## 8. Sauvegardes

```bash
mkdir -p ~/ekvara/backups
crontab -e
# 30 3 * * * /home/pi/ekvara/backend/deploy/backup-db.sh >> /home/pi/ekvara/backups/backup.log 2>&1
```

Copier régulièrement `~/ekvara/backups` hors du Pi (Mac, disque externe) :
une sauvegarde sur la même carte SD ne protège pas d'une panne de la carte.

Restaurer : `pg_restore --clean --no-owner --dbname="$DATABASE_URL" fichier.dump`

## 8 bis. Synchro des sources (tous les 3 jours)

Compétitions (FFTDA, calendrier WT, Martial Events) et résultats WT récents
des athlètes. Une date ou un lieu modifié à la source est reporté sur la
fiche et notifié aux athlètes inscrits et aux coachs concernés.

```bash
crontab -e
# 0 4 */3 * * /home/pi/ekvara/backend/deploy/sync-sources.sh
tail -n 50 ~/ekvara/sync/sync.log     # résumé de la dernière synchro
```

Lancer à la main : `cd ~/ekvara/backend && ./deploy/sync-sources.sh`.

## 9. Mettre à jour

- API (sur le Pi) : `cd ~/ekvara/backend && ./deploy/update-backend.sh`
  (sauvegarde → pull → build → migrations → reload → `/health`).
- Frontends (sur le Mac) : relancer `publish-frontends.sh`.

## En cas de problème

| Symptôme | Où regarder |
|---|---|
| `api.../health` ne répond pas | `pm2 logs ekvara-api`, `sudo systemctl status cloudflared` |
| Page blanche sur app/coach | `ls /srv/ekvara/athlete`, `sudo journalctl -u caddy` |
| Connexion impossible, erreur CORS dans la console | `CORS_ORIGINS` dans `.env`, puis `pm2 reload ekvara-api --update-env` |
| Connecté puis déconnecté aussitôt | les 3 sites doivent être en https et sur le même domaine |
| `/health` = `database: unreachable` | `sudo systemctl status postgresql`, `DATABASE_URL` |
