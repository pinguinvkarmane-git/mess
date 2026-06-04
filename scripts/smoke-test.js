import { spawn } from 'node:child_process';

const port = 3219;
const accessCode = 'smoke-code';
const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    MESS_COMPANY_CODE: accessCode
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

const output = [];
server.stdout.on('data', (chunk) => output.push(chunk.toString()));
server.stderr.on('data', (chunk) => output.push(chunk.toString()));

try {
  await waitForHealth();

  const anna = await openClient('Анна');
  const boris = await openClient('Борис');
  const receivedByBoris = waitForPayload(
    boris.socket,
    (payload) => payload.type === 'message' && payload.message?.text === 'Smoke test message',
    3000
  );

  anna.socket.send(JSON.stringify({
    type: 'message',
    text: 'Smoke test message'
  }));

  await receivedByBoris;
  anna.socket.close();
  boris.socket.close();
  console.log('Smoke test passed');
} finally {
  server.kill();
}

async function waitForHealth() {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await delay(120);
    }
  }

  throw new Error(`Server did not start:\n${output.join('')}`);
}

function openClient(name) {
  return new Promise((resolveClient, rejectClient) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timeout = setTimeout(() => rejectClient(new Error(`Client ${name} did not join`)), 3000);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        type: 'join',
        name,
        department: 'QA',
        companyCode: accessCode,
        channel: 'general'
      }));
    });

    socket.addEventListener('message', (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === 'welcome') {
        clearTimeout(timeout);
        resolveClient({ socket, payload });
      }
    });

    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      rejectClient(new Error(`Client ${name} connection failed`));
    });
  });
}

function waitForPayload(socket, predicate, timeoutMs) {
  return new Promise((resolvePayload, rejectPayload) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      rejectPayload(new Error('Timed out waiting for WebSocket payload'));
    }, timeoutMs);

    function onMessage(event) {
      const payload = JSON.parse(event.data);
      if (predicate(payload)) {
        clearTimeout(timeout);
        socket.removeEventListener('message', onMessage);
        resolvePayload(payload);
      }
    }

    socket.addEventListener('message', onMessage);
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
