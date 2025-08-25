import 'dotenv/config';
import express from 'express';
import http from 'http';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import { AccessToken } from 'livekit-server-sdk';
import uid from 'uid-safe';
import Joi from 'joi';
import geoip from 'geoip-lite';
import fetch from 'node-fetch';

const {
  PORT = 8080,
  PUBLIC_ORIGIN = 'http://localhost:5173',
  WEBSOCKET_ORIGIN = 'http://localhost:5173',
  REDIS_URL = 'redis://localhost:6379',
  LIVEKIT_HOST = 'ws://localhost:7880',
  LIVEKIT_API_KEY = 'devkey',
  LIVEKIT_API_SECRET = 'devsecret',
  NEXT_COOLDOWN_SECONDS = 5,
  MATCH_SAME_COUNTRY_BIAS = 0.7,
  RECAPTCHA_SECRET,
} = process.env;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/match' });
const redis = new Redis(REDIS_URL);

app.use(helmet());
app.use(cors({ origin: PUBLIC_ORIGIN, credentials: true }));
app.use(express.json({ limit: '100kb' }));

// Rate limits
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use('/api/', apiLimiter);

// Simple schema validation
const reportSchema = Joi.object({
  reason: Joi.string().max(200).required(),
  peerId: Joi.string().required(),
  room: Joi.string().required()
});

// Verify CAPTCHA (optional in dev)
async function verifyCaptcha(token) {
  if (!RECAPTCHA_SECRET) return true; // skip in dev
  try {
    const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token })
    });
    const data = await res.json();
    return !!data.success;
  } catch {
    return false;
  }
}

// Token issuance for LiveKit
function createLiveKitToken({ identity, room }) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: '1h'
  });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
  });
  return at.toJwt();
}

// Country detection (IP-based, best-effort)
function getCountryFromReq(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = Array.isArray(fwd) ? fwd[0] : (fwd || req.socket.remoteAddress || '');
  const g = geoip.lookup(ip);
  return g?.country || null;
}

// REST: health
app.get('/api/health', (_, res) => res.json({ ok: true }));

// REST: create soft account (OTP/email stub) — demo only
app.post('/api/register', (req, res) => {
  const id = uid.sync(16);
  // In real life, send OTP/email; store minimal profile
  res.json({ id });
});

// REST: report user
app.post('/api/report', async (req, res) => {
  const { error, value } = reportSchema.validate(req.body || {});
  if (error) return res.status(400).json({ error: error.message });
  // Append to moderation stream
  await redis.xadd('reports', '*', 'payload', JSON.stringify({
    ...value,
    ts: Date.now()
  }));
  return res.json({ ok: true });
});

// Matchmaking via WebSocket
// Protocol: client sends JSON {type: 'find', tags, lang, recaptchaToken}
//           server replies with {type:'matched', room, token, partner}
//           Next: {type:'next'}
//           Leave: {type:'leave'}
//           Report: {type:'report', reason}
const waitingKey = 'waiting:list';

// In-memory state for cooldowns
const nextCooldown = new Map(); // clientId -> ts

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function countryBiasMatch(list, prefer) {
  if (!prefer) return 0;
  const idx = list.findIndex(x => x.country === prefer);
  if (idx === -1) return 0;
  // With probability bias, take that index, else 0
  if (Math.random() < Number(MATCH_SAME_COUNTRY_BIAS)) return idx;
  return 0;
}

wss.on('connection', async (ws, req) => {
  ws.id = uid.sync(12);
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()) } catch { return; }
    if (msg.type === 'find') {
      // CAPTCHA
      if (!(await verifyCaptcha(msg.recaptchaToken || ''))) {
        safeSend(ws, { type: 'error', error: 'captcha_failed' });
        return;
      }
      // Cooldown check (avoid instant skip abuse)
      const last = nextCooldown.get(ws.id) || 0;
      if (Date.now() - last < Number(NEXT_COOLDOWN_SECONDS) * 1000) {
        safeSend(ws, { type: 'cooldown', seconds: Math.ceil((Number(NEXT_COOLDOWN_SECONDS)*1000 - (Date.now()-last))/1000) });
        return;
      }

      const country = getCountryFromReq(req);
      const entry = JSON.stringify({
        id: ws.id,
        ts: Date.now(),
        tags: Array.isArray(msg.tags) ? msg.tags.slice(0,5) : [],
        lang: (msg.lang || '').slice(0,16),
        country,
      });

      // Try to match: pop all, try find compatible, else push back
      const len = await redis.llen(waitingKey);
      if (len > 0) {
        const candidates = await redis.lrange(waitingKey, 0, Math.min(50, len-1));
        const parsed = candidates.map(JSON.parse);
        let idx = countryBiasMatch(parsed, country);
        // Try also by tag/lang overlap
        const tags = new Set(JSON.parse(entry).tags);
        const lang = JSON.parse(entry).lang;
        for (let i=0;i<parsed.length;i++) {
          const p = parsed[i];
          const overlap = p.tags?.some(t => tags.has(t));
          const langOK = !lang || !p.lang || p.lang === lang;
          if (overlap || langOK) { idx = i; break; }
        }
        const chosen = parsed[idx] || parsed[0];
        // remove chosen
        await redis.lrem(waitingKey, 1, JSON.stringify(chosen));

        // Create a room and tokens
        const room = `pair_${uid.sync(8)}`;
        const tokenSelf = createLiveKitToken({ identity: ws.id, room });
        const tokenPeer = createLiveKitToken({ identity: chosen.id, room });

        // Notify current and try to notify peer (if connected)
        safeSend(ws, { type: 'matched', room, token: tokenSelf, partner: { id: chosen.id } });
        // Store peer mapping for server-initiated messages if needed
        ws.currentRoom = room;

        // We can't push to that peer directly without its ws handle here in a multi-node setup.
        // Instead, store a signal in Redis that the peer should poll (client auto-polls below).
        await redis.setex(`match:${chosen.id}`, 60, JSON.stringify({ room, token: tokenPeer, partner: { id: ws.id } }));
      } else {
        await redis.rpush(waitingKey, entry);
        safeSend(ws, { type: 'queued' });
      }
    }

    if (msg.type === 'poll') {
      const payload = await redis.getdel(`match:${ws.id}`);
      if (payload) {
        const p = JSON.parse(payload);
        ws.currentRoom = p.room;
        safeSend(ws, { type: 'matched', ...p });
      }
    }

    if (msg.type === 'next') {
      nextCooldown.set(ws.id, Date.now());
      // Leave room logically. Client will disconnect from LiveKit itself.
      safeSend(ws, { type: 'left' });
      // Immediately attempt to find a new partner (user flow like Omegle)
      safeSend(ws, { type: 'queued' });
    }

    if (msg.type === 'leave') {
      nextCooldown.set(ws.id, Date.now());
      safeSend(ws, { type: 'left' });
    }

    if (msg.type === 'report') {
      const { error } = reportSchema.validate({ ...msg, peerId: msg.peerId || '', room: ws.currentRoom || '' });
      if (!error) {
        await redis.xadd('reports', '*', 'payload', JSON.stringify({ reason: msg.reason, peerId: msg.peerId, room: ws.currentRoom, reporter: ws.id, ts: Date.now() }));
      }
      safeSend(ws, { type: 'ok' });
    }
  });

  ws.on('close', () => {});
  ws.on('error', () => {});
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`API/Matchmaking on http://0.0.0.0:${PORT}`);
  console.log(`WebSocket at ws://0.0.0.0:${PORT}/match`);
});
