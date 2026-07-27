# Solchan V2 Backend

Off-chain evidence backend for the Solchan V2 MVP.

## Stack

- Node.js
- Express
- TypeScript
- PostgreSQL
- Manual SQL migrations through `pg`
- Local file storage for MVP evidence documents

## Setup

```bash
cp .env.example .env
npm install
docker-compose up -d postgres
npm run migrate
npm run dev
```

The API defaults to:

```txt
http://localhost:4000
```

## API

```txt
GET  /health
POST /organizations
GET  /organizations/:id
POST /organizations/:id/accreditation-requests
POST /organizations/:id/evidence-documents
POST /accreditation-requests/:id/manifest
PATCH /accreditation-requests/:id/onchain
GET  /admin/accreditation-requests
GET  /admin/accreditation-requests/:id
POST /admin/accreditation-requests/:id/notes
```

Solana remains the source of truth for protocol decisions. This backend stores
documents, metadata, manifests, and review context.
