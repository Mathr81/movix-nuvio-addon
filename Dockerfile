# Image de l'addon Movix (usage personnel, un seul utilisateur).
#
#   docker build -t movix-addon .
#   docker run -d --name movix-addon -p 8787:8787 --env-file .env -v movix-data:/app/data movix-addon
#
# Le volume est ce qui compte: `data/` porte le cache persistant, l'instantane du hub et
# son journal. Sans lui, chaque redemarrage du conteneur repaye le scraping, l'extraction
# et la mesure de debit de chaque fiche -- et le hub repart d'une union complete.

FROM node:22-alpine

# `tini` donne un vrai PID 1: sans lui, Node ignore SIGTERM et `docker stop` attend
# 10 s avant de tuer le process, ce qui coupe une ecriture de cache en cours.
#
# `ffmpeg` sert au CALAGE AUTOMATIQUE des sous-titres: il ecoute quelques fenetres du flux
# pour reperer ou l'on y parle (cf. src/streaming/subtitles/speech.js). Il pese une
# centaine de Mo dans l'image -- si l'on prefere s'en passer, le retirer d'ici suffit:
# l'addon detecte son absence au demarrage, desactive le calage et sert les pistes telles
# quelles. Rien d'autre n'en depend.
RUN apk add --no-cache tini ffmpeg

WORKDIR /app

# Les dependances sont copiees seules pour que le cache de couche Docker survive a toute
# modification du code: `npm ci` ne se rejoue que si package*.json a change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src

# `data/` appartient a l'utilisateur non-root, sinon l'ecriture du cache echoue au
# premier cycle -- silencieusement, puisque le cache est concu pour tolerer les pannes.
RUN mkdir -p data && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Le serveur ecoute sur toutes les interfaces; 127.0.0.1 suffit donc depuis le conteneur.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
