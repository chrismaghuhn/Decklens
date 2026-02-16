# Cloudflare Pages Deployment Script

# Voraussetzungen: wrangler installiert und eingeloggt (wrangler login)

# Setze Variablen
PROJECT_NAME="mtg-deckbuilder" # Dein Projektname auf Cloudflare
REPO_URL="https://github.com/dein-name/mtg-deckbuilder.git" # Deine Git Repo URL
BUILD_COMMAND="npm run build" # Build-Befehl für dein Frontend (passe an)
OUTPUT_DIR="public" # Verzeichnis mit dem built Frontend

# Erstelle Cloudflare Pages Projekt
wrangler pages project create $PROJECT_NAME

# Deploye das Projekt
wrangler pages deploy $OUTPUT_DIR --project-name $PROJECT_NAME --branch production

# Optional: Konfiguriere Custom Domain (in Cloudflare Dashboard)
echo "Deployment abgeschlossen! Gehe zu https://$PROJECT_NAME.pages.dev um es zu sehen."
