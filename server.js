import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(__dirname, 'public');
const dataDir = resolve(__dirname, 'data');
const messagesFile = join(dataDir, 'messages.json');

const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '0.0.0.0';
const companyCode = process.env.MESS_COMPANY_CODE || '';
const historyLimit = 250;
const maxMessageLength = 2000;

const channels = [
  {
    id: 'general',
    name: 'Общий',
    description: 'Новости, быстрые вопросы и общие обсуждения',
    accent: '#087f72'
  },
  {
    id: 'projects',
    name: 'Проекты',
    description: 'Рабочие задачи, статусы и договорённости',
    accent: '#7a5cbd'
  },
  {
    id: 'support',
    name: 'Поддержка',
    description: 'Технические вопросы и помощь коллегам',
    accent: '#c25a3a'
  },
  {
    id: 'announcements',
    name: 'Объявления',
    description: 'Важные сообщения для всей команды',
    accent: '#b47a18'
  }
];

const channelIds = new Set(channels.map((channel) => channel.id));
const clients = new Map();
const typingTimers = new Map();
let messageStore = loadMessages();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon'
};

const server = createServer((request, response) => {
  if (request.url === '/health') {
    sendJson(response, 200, {
      ok: true,
      clients: clients.size,
      channels: channels.length
    });
    return;
  }

  serveStatic(request, response);
});

server.on('upgrade', (request, socket) => {
  if (!request.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }

  const key = request.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));

  const state = {
    id: randomUUID(),
    name: 'Гость',
    department: '',
    color: pickColor(),
    channel: 'general',
    joined: false,
    buffer: Buffer.alloc(0),
    lastMessageAt: 0
  };

  clients.set(socket, state);

  socket.on('data', (chunk) => handleSocketData(socket, chunk));
  socket.on('close', () => removeClient(socket));
  socket.on('end', () => removeClient(socket));
  socket.on('error', () => removeClient(socket));

  sendFrame(socket, {
    type: 'hello',
    clientId: state.id,
    channels,
    requiresCode: Boolean(companyCode)
  });
});

server.listen(port, host, () => {
  console.log(`Company Messenger is running at http://${host}:${port}`);
});

function serveStatic(request, response) {
  let pathname = '/';

  try {
    pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
  } catch {
    sendText(response, 400, 'Bad request');
    return;
  }

  const normalized = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const relativePath = normalized === '/' ? 'index.html' : normalized.replace(/^[/\\]/, '');
  const filePath = resolve(publicDir, relativePath);

  if (!filePath.startsWith(publicDir)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(response, 404, 'Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': relativePath === 'index.html' ? 'no-store' : 'public, max-age=3600'
  });

  createReadStream(filePath).pipe(response);
}

function handleSocketData(socket, chunk) {
  const state = clients.get(socket);
  if (!state) {
    return;
  }

  state.buffer = Buffer.concat([state.buffer, chunk]);

  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let payloadLength = second & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (state.buffer.length < offset + 2) return;
      payloadLength = state.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (state.buffer.length < offset + 8) return;
      const bigLength = state.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(1024 * 1024)) {
        socket.end();
        return;
      }
      payloadLength = Number(bigLength);
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = offset + maskLength + payloadLength;
    if (state.buffer.length < frameLength) {
      return;
    }

    const mask = masked ? state.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + payloadLength));
    state.buffer = state.buffer.subarray(frameLength);

    if (masked && mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    if (opcode === 0x8) {
      socket.end();
      return;
    }

    if (opcode === 0x9) {
      sendRawFrame(socket, payload, 0x0a);
      continue;
    }

    if (opcode !== 0x1) {
      continue;
    }

    try {
      handleClientMessage(socket, JSON.parse(payload.toString('utf8')));
    } catch {
      sendFrame(socket, {
        type: 'error',
        message: 'Не удалось прочитать сообщение.'
      });
    }
  }
}

function handleClientMessage(socket, payload) {
  const state = clients.get(socket);
  if (!state || !payload || typeof payload !== 'object') {
    return;
  }

  if (payload.type === 'join') {
    joinClient(socket, payload);
    return;
  }

  if (!state.joined) {
    sendFrame(socket, {
      type: 'error',
      message: 'Сначала войдите в мессенджер.'
    });
    return;
  }

  if (payload.type === 'message') {
    addChatMessage(socket, payload);
    return;
  }

  if (payload.type === 'switchChannel') {
    switchChannel(socket, payload.channel);
    return;
  }

  if (payload.type === 'typing') {
    broadcastTyping(socket);
    return;
  }

  if (payload.type === 'profile') {
    updateProfile(socket, payload);
  }
}

function joinClient(socket, payload) {
  const state = clients.get(socket);
  if (!state) {
    return;
  }

  if (companyCode && payload.companyCode !== companyCode) {
    sendFrame(socket, {
      type: 'authError',
      message: 'Неверный код доступа компании.'
    });
    return;
  }

  state.name = sanitizeText(payload.name, 48) || 'Коллега';
  state.department = sanitizeText(payload.department, 64);
  state.channel = normalizeChannel(payload.channel);
  state.joined = true;

  sendFrame(socket, {
    type: 'welcome',
    me: publicUser(state),
    channels,
    activeChannel: state.channel,
    history: getHistory(state.channel),
    users: getUsersByChannel(state.channel)
  });

  broadcastPresence(state.channel);
}

function updateProfile(socket, payload) {
  const state = clients.get(socket);
  if (!state) {
    return;
  }

  state.name = sanitizeText(payload.name, 48) || state.name;
  state.department = sanitizeText(payload.department, 64);

  sendFrame(socket, {
    type: 'profile',
    me: publicUser(state)
  });

  broadcastPresence(state.channel);
}

function addChatMessage(socket, payload) {
  const state = clients.get(socket);
  if (!state) {
    return;
  }

  const now = Date.now();
  if (now - state.lastMessageAt < 350) {
    sendFrame(socket, {
      type: 'error',
      message: 'Слишком часто. Подождите секунду.'
    });
    return;
  }

  const text = sanitizeText(payload.text, maxMessageLength);
  if (!text) {
    return;
  }

  state.lastMessageAt = now;

  const message = {
    id: randomUUID(),
    channel: state.channel,
    authorId: state.id,
    authorName: state.name,
    department: state.department,
    color: state.color,
    text,
    createdAt: new Date().toISOString()
  };

  if (!messageStore[state.channel]) {
    messageStore[state.channel] = [];
  }

  messageStore[state.channel].push(message);
  messageStore[state.channel] = messageStore[state.channel].slice(-historyLimit);
  saveMessages();

  broadcastToChannel(state.channel, {
    type: 'message',
    message
  });
}

function switchChannel(socket, channel) {
  const state = clients.get(socket);
  if (!state) {
    return;
  }

  const previousChannel = state.channel;
  state.channel = normalizeChannel(channel);

  sendFrame(socket, {
    type: 'channel',
    activeChannel: state.channel,
    history: getHistory(state.channel),
    users: getUsersByChannel(state.channel)
  });

  broadcastPresence(previousChannel);
  broadcastPresence(state.channel);
}

function broadcastTyping(socket) {
  const state = clients.get(socket);
  if (!state) {
    return;
  }

  const key = `${state.channel}:${state.id}`;
  clearTimeout(typingTimers.get(key));

  broadcastToChannel(state.channel, {
    type: 'typing',
    user: publicUser(state)
  }, socket);

  typingTimers.set(key, setTimeout(() => {
    broadcastToChannel(state.channel, {
      type: 'typingStop',
      userId: state.id
    }, socket);
    typingTimers.delete(key);
  }, 1800));
}

function broadcastPresence(channel) {
  broadcastToChannel(channel, {
    type: 'presence',
    users: getUsersByChannel(channel),
    channel
  });
}

function broadcastToChannel(channel, payload, exceptSocket = null) {
  for (const [socket, state] of clients.entries()) {
    if (!state.joined || state.channel !== channel || socket === exceptSocket) {
      continue;
    }

    sendFrame(socket, payload);
  }
}

function removeClient(socket) {
  const state = clients.get(socket);
  if (!state) {
    return;
  }

  clients.delete(socket);
  broadcastPresence(state.channel);
}

function sendFrame(socket, payload) {
  sendRawFrame(socket, Buffer.from(JSON.stringify(payload), 'utf8'), 0x1);
}

function sendRawFrame(socket, payload, opcode) {
  if (socket.destroyed) {
    return;
  }

  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  socket.write(Buffer.concat([header, payload]));
}

function getUsersByChannel(channel) {
  return [...clients.values()]
    .filter((state) => state.joined && state.channel === channel)
    .map(publicUser)
    .sort((first, second) => first.name.localeCompare(second.name, 'ru'));
}

function publicUser(state) {
  return {
    id: state.id,
    name: state.name,
    department: state.department,
    color: state.color
  };
}

function getHistory(channel) {
  return messageStore[normalizeChannel(channel)] || [];
}

function normalizeChannel(channel) {
  return channelIds.has(channel) ? channel : 'general';
}

function sanitizeText(value, limit) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function pickColor() {
  const colors = ['#087f72', '#7a5cbd', '#c25a3a', '#3f6f9f', '#9a6b12', '#4f7d45', '#a94a69', '#5d6b34'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function loadMessages() {
  mkdirSync(dataDir, { recursive: true });

  if (!existsSync(messagesFile)) {
    return Object.fromEntries(channels.map((channel) => [channel.id, []]));
  }

  try {
    const parsed = JSON.parse(readFileSync(messagesFile, 'utf8'));
    return Object.fromEntries(channels.map((channel) => [
      channel.id,
      Array.isArray(parsed[channel.id]) ? parsed[channel.id].slice(-historyLimit) : []
    ]));
  } catch {
    return Object.fromEntries(channels.map((channel) => [channel.id, []]));
  }
}

function saveMessages() {
  mkdirSync(dataDir, { recursive: true });
  const temporaryFile = `${messagesFile}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(messageStore, null, 2));
  renameSync(temporaryFile, messagesFile);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8'
  });
  response.end(message);
}
