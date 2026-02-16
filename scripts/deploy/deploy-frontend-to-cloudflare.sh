# Cloudflare Pages Deployment for Frontend (decklens.chrisgarkisch.workers.dev)

# Voraussetzungen: wrangler installiert und eingeloggt

# Setze Variablen
PROJECT_NAME="decklens-frontend" # Name des Pages-Projekts
GIT_REPO="https://github.com/chrisgarkisch/decklens.git" # Deine Git Repo (passe an)
BUILD_COMMAND="npm install && npm run build" # Build-Befehl (passe an)
OUTPUT_DIR="build" # Output-Verzeichnis (passe an)
DOMAIN="decklens.chrisgarkisch.workers.dev" # Deine Custom Domain

# Erstelle Pages-Projekt (einmalig)
wrangler pages project create $PROJECT_NAME --production-branch main

# Deploye aus Git Repo
wrangler pages deploy --project-name $PROJECT_NAME --branch production --commit-message "Deploy frontend" --git-repo $GIT_REPO --build-command "$BUILD_COMMAND" --build-output-dir $OUTPUT_DIR

# Binde Custom Domain (einmalig)
wrangler pages domain add $PROJECT_NAME $DOMAIN

echo "Frontend deployed to $DOMAIN!"
