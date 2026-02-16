# Cloudflare Workers Deployment for API (decklens-api.chrisgarkisch.workers.dev)

# Voraussetzungen: wrangler installiert und eingeloggt

# Setze Variablen
WORKER_NAME="decklens-api" # Name des Workers
WORKER_SCRIPT="packages/api/worker.js" # Path zu deinem Worker-Script (passe an)
ROUTE="decklens-api.chrisgarkisch.workers.dev/*" # Route für die Domain

# Deploye den Worker
wrangler deploy $WORKER_SCRIPT --name $WORKER_NAME

# Binde die Custom Domain (falls nicht schon geschehen)
wrangler custom-domain add $ROUTE

echo "API deployed to $ROUTE!"
