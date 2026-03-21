# MenuDash — Real-Time Food Delivery Price Comparison

Scrapes DoorDash, GrubHub, Seamless, and Uber Eats simultaneously using
headless Playwright browsers, then ranks results by total cost (item + delivery fee).

## Architecture

- **4 parallel Playwright scrapers** — one per platform, run concurrently
- **Node.js Express backend** — orchestrates scrapers, serves API + frontend
- **Aggregator** — normalizes prices, deduplicates, ranks by total cost
- **Single-page frontend** — comparison table with sort controls and best-value highlights

---

## Quick Start (Local)

```bash
# 1. Clone and install
npm install
npm run install-browsers

# 2. Configure credentials
cp .env.example .env
# Edit .env with your delivery platform credentials

# 3. Run
npm start
# Open http://localhost:3001
```

---

## Cloud Deployment (AWS/GCP/DigitalOcean)

### Recommended server specs
- **2 vCPUs minimum** (4 preferred — one per browser instance)
- **4GB RAM minimum** (each Chromium instance uses ~400-600MB)
- Ubuntu 22.04 LTS

### DigitalOcean (easiest)
```bash
# Create a $24/mo Droplet (4GB RAM / 2 vCPU)
# SSH in, then:

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Clone your repo
git clone <your-repo> menuscraper
cd menuscraper

# Configure
cp .env.example .env
nano .env   # add your credentials

# Deploy
docker-compose up -d

# Check logs
docker-compose logs -f
```

### AWS EC2
```bash
# Launch t3.medium (4GB RAM) with Ubuntu 22.04
# Security group: open port 3001 (or 80 with nginx)
# Then same Docker steps as above
```

### GCP Cloud Run (serverless option)
```bash
# Build and push
gcloud builds submit --tag gcr.io/YOUR_PROJECT/menuscraper
gcloud run deploy menuscraper \
  --image gcr.io/YOUR_PROJECT/menuscraper \
  --platform managed \
  --memory 4Gi \
  --cpu 2 \
  --port 3001 \
  --set-env-vars "$(cat .env | tr '\n' ',')"
```

---

## .env Configuration

```env
PORT=3001

DOORDASH_EMAIL=you@email.com
DOORDASH_PASSWORD=yourpassword

GRUBHUB_EMAIL=you@email.com
GRUBHUB_PASSWORD=yourpassword

UBEREATS_EMAIL=you@email.com
UBEREATS_PASSWORD=yourpassword

HEADLESS=true
SCRAPE_TIMEOUT_MS=30000
DEFAULT_ADDRESS=86 Horsneck Point Rd, Oceanport NJ 07757
```

> **Note:** Seamless uses GrubHub credentials — they share the same backend.

---

## API

### POST /api/search
```json
{
  "dish": "chicken soup",
  "address": "86 Horsneck Point Rd, Oceanport NJ 07757",
  "platforms": ["doordash", "grubhub", "seamless", "ubereats"],
  "rankBy": "totalPrice"
}
```

**rankBy options:** `totalPrice` | `itemPrice` | `rating` | `eta`

### Response
```json
{
  "dish": "chicken soup",
  "elapsedSeconds": 18.4,
  "summary": {
    "highlights": {
      "bestValue": { "platform": "DoorDash", "restaurant": "...", "totalPrice": 14.99 },
      "bestRated": { "platform": "Uber Eats", "restaurant": "...", "rating": 4.8 },
      "fastestDelivery": { "platform": "GrubHub", "restaurant": "...", "eta": "20-30 min" }
    }
  },
  "results": [
    {
      "platform": "DoorDash",
      "restaurant": "Shanghai Garden",
      "item": "Chicken Soup",
      "itemPrice": 9.99,
      "deliveryFee": 2.99,
      "totalPrice": 12.98,
      "rating": 4.6,
      "eta": "25-35 min",
      "isBestValue": true
    }
  ]
}
```

---

## Important Notes

1. **ToS** — Scraping these platforms violates their Terms of Service. Use for personal/internal use only.
2. **Login required** — Without credentials, platforms show limited/no pricing. Add your credentials to .env.
3. **Anti-bot** — These platforms use bot detection. If scraping fails, try `HEADLESS=false` to debug locally.
4. **Seamless = GrubHub** — They share the same infrastructure. Results may overlap; the aggregator deduplicates.
5. **Search latency** — Expect 20-40s total (all 4 browsers run in parallel, not series).
