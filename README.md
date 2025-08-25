# Stranger Video + Chat — Full Stack (LiveKit + Redis + TURN)

This project implements a production-ready baseline for a **random 1:1 stranger chat** with video, text, safety features, and compliance scaffolding.

## Key Features
- Random pairing with **Redis** queue and **WebSocket** control (`Next`, `Leave`, report/block).
- **LiveKit** SFU media (scalable, recordings-ready, moderation hooks).
- **TURN (coturn)** for NAT traversal.
- **Safety & moderation**: age-gate, CAPTCHA (hook), text filter, report/ban endpoints, Next cooldown, rate limiting.
- **Interest tags / language filters / country bias**.
- **Anonymous-soft accounts** (OTP/email stub), trust levels, shadow bans (scaffold).
- **DevOps**: Docker Compose, TLS-ready reverse proxy examples, CI stub.
- **Compliance (India)**: IT Rules 2021 pages and SOP templates in `/docs`.

> ⚠️ Replace all placeholders and secrets before deploying publicly. Consult a lawyer for compliance in your jurisdiction.

---

## Quick Start (local, dev-only)

### 0) Prereqs
- Docker & Docker Compose
- Node.js 18+ (if running server locally outside Docker)
- A domain (for HTTPS in prod)

### 1) Configure environment
Copy `.env.example` to `.env` and fill values (LiveKit keys, TURN creds, etc.).

```bash
cp .env.example .env
```

### 2) Run the stack
```bash
docker compose up --build
```

- Web app: http://localhost:5173
- API/Matchmaking: http://localhost:8080
- LiveKit: ws://localhost:7880 (dev, no TLS)
- Redis: localhost:6379
- coturn (TURN): 3478/udp

> For camera/mic in the browser **you need HTTPS** when not on `localhost`. Use a reverse proxy + TLS in production.

### 3) Test
Open the web app in **two browser tabs**. Click **Start**, allow camera/mic, and you should get matched. Use **Next** to skip.

---

## Stack
- **web**: React + Vite + Tailwind + LiveKit React components
- **server**: Node/Express + WebSocket + Redis + livekit-server-sdk
- **infra**: Docker Compose for server, web, Redis, coturn, LiveKit
- **docs**: ToS, Privacy Policy, Grievance Officer, Moderation SOP

---

## Production Notes
- Put **TLS** in front of API and LiveKit (Caddy/NGINX examples included).
- Use **TURN over TLS (5349)** with real certs.
- Configure **CAPTCHA** site/secret keys.
- Wire **recordings** and storage (S3/GCS) if you enable it.
- Enforce **rate limits**, abuse scoring, and moderation workflows.
- Maintain **audit logs** (anonymized where possible, encrypted at rest).
