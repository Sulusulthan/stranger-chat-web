import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LiveKitRoom,
  GridLayout,
  RoomAudioRenderer,
  ControlBar,
  useTracks,
  ParticipantTile,
  TrackReference
} from '@livekit/components-react';

import '@livekit/components-styles';
import './index.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/match';
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN || 'http://localhost:8080';

function TrackGrid() {
  const tracks = useTracks(
    [
      { source: 'camera', withPlaceholder: true },
      { source: 'microphone', withPlaceholder: false }
    ],
    { onlySubscribed: true }
  );
  return (
    <GridLayout tracks={tracks}>
      {tracks.map((trackRef) => (
        <ParticipantTile
          key={trackRef.participant.identity + trackRef.source}
          trackRef={trackRef}
        />
      ))}
    </GridLayout>
  );
}

function App() {
  const [room, setRoom] = useState(null);
  const [token, setToken] = useState(null);
  const [queued, setQueued] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [tags, setTags] = useState(['random']);
  const [lang, setLang] = useState('en');
  const [captchaToken, setCaptchaToken] = useState('dev');
  const [chat, setChat] = useState([]);
  const [interestInput, setInterestInput] = useState('coding,anime,football');
  const [countryBias, setCountryBias] = useState(true);
  const [reportReason, setReportReason] = useState('');

  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'queued') setQueued(true);
      if (msg.type === 'matched') {
        setRoom(msg.room);
        setToken(msg.token);
        setQueued(false);
      }
      if (msg.type === 'cooldown') setCooldown(msg.seconds || 0);
      if (msg.type === 'left') {
        setRoom(null);
        setToken(null);
      }
      if (msg.type === 'error') alert('Error: ' + msg.error);
    };
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'poll' }));
      }
    }, 1000);
    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, []);

  useEffect(() => {
    setTags(
      interestInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5)
    );
  }, [interestInput]);

  const start = async () => {
    try {
      const roomName = 'public';
      const participantName = 'guest-' + Math.random().toString(36).slice(2, 8);
      const res = await fetch(API_ORIGIN + '/get-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomName, participantName })
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error('token_request_failed: ' + txt);
      }
      const data = await res.json();
      setToken(data.token);
      setRoom(roomName);
      setQueued(false);
    } catch (err) {
      console.error(err);
      alert('Failed to start: ' + (err?.message || 'unknown_error'));
    }
  };
  const next = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'next' }));
    } else {
      console.warn('WS not open; ignoring next');
    }
  };
  const leave = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'leave' }));
    } else {
      console.warn('WS not open; ignoring leave');
    }
  };
  const report = async () => {
    const reason = prompt('Report reason:', reportReason || 'abuse');
    if (!reason) return;
    try {
      await fetch(API_ORIGIN + '/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason,
          peerId: 'unknown',
          room: room || ''
        })
      });
      alert('Reported. Our team will review.');
    } catch {
      alert('Failed to report.');
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Stranger Video Chat</h1>
        <div className="flex items-center gap-2">
          <span className="badge">{connected ? 'Connected' : 'Offline'}</span>
          <button
            className="btn-secondary"
            onClick={() => window.open('/docs/tos.html', '_blank')}
          >
            ToS
          </button>
          <button
            className="btn-secondary"
            onClick={() => window.open('/docs/privacy.html', '_blank')}
          >
            Privacy
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 card">
          {!token ? (
            <div className="space-y-3">
              <p>
                Click <b>Start</b> to join the queue and get matched with a
                stranger.
              </p>
              <div className="flex gap-2">
                <button className="btn" onClick={start} disabled={cooldown > 0}>
                  Start
                </button>
                <button
                  className="btn-secondary"
                  onClick={next}
                  disabled={cooldown > 0 || !connected}
                >
                  Next
                </button>
                <button className="btn-secondary" onClick={leave} disabled={!connected}>
                  Leave
                </button>
                {cooldown > 0 && (
                  <span className="badge">Cooldown: {cooldown}s</span>
                )}
              </div>
              {queued && <small>Waiting for a partner…</small>}
            </div>
          ) : (
            <LiveKitRoom
              video
              audio
              token={token}
              serverUrl={import.meta.env.VITE_LIVEKIT_URL || undefined}
              connect
              data-lk-theme="default"
              style={{ height: 520 }}
              onDisconnected={() => {
                setToken(null);
                setRoom(null);
              }}
            >
              <TrackGrid />
              <RoomAudioRenderer />
              <ControlBar
                variation="minimal"
                controls={{ screenShare: false, leave: true }}
              />
              <div className="mt-2 flex gap-2">
                <button className="btn-secondary" onClick={next} disabled={!connected || cooldown > 0}>
                  Next
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setToken(null)}
                >
                  Disconnect
                </button>
                <button className="btn-secondary" onClick={report}>
                  Report
                </button>
              </div>
            </LiveKitRoom>
          )}
        </div>
        <aside className="card space-y-3">
          <h2 className="font-semibold">Filters</h2>
          <div className="space-y-2">
            <label className="block text-sm">Interests (comma separated)</label>
            <input
              className="input"
              value={interestInput}
              onChange={(e) => setInterestInput(e.target.value)}
              placeholder="anime,football,coding"
            />
            <label className="block text-sm">Language</label>
            <select
              className="input"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
            >
              <option value="en">English</option>
              <option value="hi">Hindi</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="ar">Arabic</option>
            </select>
          </div>
        </aside>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
const root = createRoot(container);
root.render(<App />);
