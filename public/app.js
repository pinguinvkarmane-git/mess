const elements = {
  channelList: document.querySelector('#channelList'),
  channelTitle: document.querySelector('#channelTitle'),
  channelDescription: document.querySelector('#channelDescription'),
  channelEyebrow: document.querySelector('#channelEyebrow'),
  connectionStatus: document.querySelector('#connectionStatus'),
  messageList: document.querySelector('#messageList'),
  typingLine: document.querySelector('#typingLine'),
  composer: document.querySelector('#composer'),
  messageInput: document.querySelector('#messageInput'),
  identityModal: document.querySelector('#identityModal'),
  identityForm: document.querySelector('#identityForm'),
  nameInput: document.querySelector('#nameInput'),
  departmentInput: document.querySelector('#departmentInput'),
  companyCodeInput: document.querySelector('#companyCodeInput'),
  companyCodeLabel: document.querySelector('#companyCodeLabel'),
  formError: document.querySelector('#formError'),
  profileAvatar: document.querySelector('#profileAvatar'),
  profileName: document.querySelector('#profileName'),
  profileDepartment: document.querySelector('#profileDepartment'),
  onlineList: document.querySelector('#onlineList'),
  profileButton: document.querySelector('#profileButton'),
  logoutButton: document.querySelector('#logoutButton'),
  copyLinkButton: document.querySelector('#copyLinkButton'),
  focusComposer: document.querySelector('#focusComposer')
};

const state = {
  socket: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  me: null,
  channels: [],
  activeChannel: 'general',
  messages: [],
  users: [],
  typingUsers: new Map(),
  profile: loadProfile(),
  requiresCode: false
};

hydrateProfileForm();
setConnectionStatus('не подключено', false);
renderEmptyState();

elements.identityForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(elements.identityForm);
  state.profile = {
    name: String(formData.get('name') || '').trim(),
    department: String(formData.get('department') || '').trim(),
    companyCode: String(formData.get('companyCode') || '').trim()
  };

  if (!state.profile.name) {
    showError('Укажите имя.');
    return;
  }

  saveProfile();
  connect();
});

elements.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = elements.messageInput.value.trim();
  if (!text || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  sendSocket({
    type: 'message',
    text
  });

  elements.messageInput.value = '';
  autoSizeInput();
});

elements.messageInput.addEventListener('input', () => {
  autoSizeInput();
  sendSocket({ type: 'typing' });
});

elements.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.profileButton.addEventListener('click', () => {
  elements.identityModal.classList.add('is-visible');
  hydrateProfileForm();
});

elements.logoutButton.addEventListener('click', () => {
  localStorage.removeItem('messengerProfile');
  state.profile = loadProfile();
  state.me = null;
  if (state.socket) {
    state.socket.close();
  }
  elements.identityModal.classList.add('is-visible');
  hydrateProfileForm();
  setConnectionStatus('не подключено', false);
});

elements.copyLinkButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    elements.copyLinkButton.textContent = 'Ссылка скопирована';
    setTimeout(() => {
      elements.copyLinkButton.textContent = 'Скопировать ссылку';
    }, 1600);
  } catch {
    showError('Не удалось скопировать ссылку.');
  }
});

elements.focusComposer.addEventListener('click', () => {
  elements.messageInput.focus();
});

connect();

function connect() {
  clearTimeout(state.reconnectTimer);

  if (!state.profile.name) {
    elements.identityModal.classList.add('is-visible');
    return;
  }

  setConnectionStatus('подключение...', false);

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  state.socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  state.socket.addEventListener('open', () => {
    state.reconnectAttempts = 0;
    setConnectionStatus('онлайн', true);
  });

  state.socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    handlePayload(payload);
  });

  state.socket.addEventListener('close', () => {
    setConnectionStatus('нет связи', false);
    scheduleReconnect();
  });

  state.socket.addEventListener('error', () => {
    setConnectionStatus('ошибка связи', false);
  });
}

function handlePayload(payload) {
  if (payload.type === 'hello') {
    state.channels = payload.channels || [];
    state.requiresCode = Boolean(payload.requiresCode);
    elements.companyCodeLabel.classList.toggle('is-hidden', !state.requiresCode);
    sendSocket({
      type: 'join',
      name: state.profile.name,
      department: state.profile.department,
      companyCode: state.profile.companyCode,
      channel: state.activeChannel
    });
    renderChannels();
    return;
  }

  if (payload.type === 'authError') {
    showError(payload.message || 'Ошибка входа.');
    elements.identityModal.classList.add('is-visible');
    state.socket?.close();
    return;
  }

  if (payload.type === 'welcome') {
    state.me = payload.me;
    state.activeChannel = payload.activeChannel;
    state.messages = payload.history || [];
    state.users = payload.users || [];
    elements.identityModal.classList.remove('is-visible');
    clearError();
    renderProfile();
    renderChannels();
    renderMessages();
    renderUsers();
    return;
  }

  if (payload.type === 'channel') {
    state.activeChannel = payload.activeChannel;
    state.messages = payload.history || [];
    state.users = payload.users || [];
    state.typingUsers.clear();
    renderChannels();
    renderMessages();
    renderUsers();
    renderTyping();
    return;
  }

  if (payload.type === 'message') {
    state.messages.push(payload.message);
    renderMessages();
    return;
  }

  if (payload.type === 'presence' && payload.channel === state.activeChannel) {
    state.users = payload.users || [];
    renderUsers();
    renderChannels();
    return;
  }

  if (payload.type === 'typing' && payload.user?.id !== state.me?.id) {
    state.typingUsers.set(payload.user.id, payload.user);
    renderTyping();
    return;
  }

  if (payload.type === 'typingStop') {
    state.typingUsers.delete(payload.userId);
    renderTyping();
    return;
  }

  if (payload.type === 'profile') {
    state.me = payload.me;
    renderProfile();
  }
}

function switchChannel(channelId) {
  if (channelId === state.activeChannel) {
    return;
  }

  state.activeChannel = channelId;
  state.messages = [];
  state.users = [];
  state.typingUsers.clear();
  renderChannels();
  renderMessages();
  renderUsers();
  renderTyping();
  sendSocket({
    type: 'switchChannel',
    channel: channelId
  });
}

function renderChannels() {
  const current = state.channels.find((channel) => channel.id === state.activeChannel) || state.channels[0];
  if (current) {
    elements.channelTitle.textContent = current.name;
    elements.channelDescription.textContent = current.description;
    elements.channelEyebrow.textContent = `#${current.id}`;
  }

  elements.channelList.replaceChildren(...state.channels.map((channel) => {
    const button = document.createElement('button');
    button.className = `channel-button${channel.id === state.activeChannel ? ' is-active' : ''}`;
    button.type = 'button';
    button.addEventListener('click', () => switchChannel(channel.id));

    const dot = document.createElement('span');
    dot.className = 'channel-dot';
    dot.style.background = channel.accent;

    const name = document.createElement('span');
    name.className = 'channel-name';
    name.textContent = channel.name;

    const count = document.createElement('span');
    count.className = 'channel-count';
    count.textContent = channel.id === state.activeChannel ? String(state.users.length) : '';

    button.append(dot, name, count);
    return button;
  }));
}

function renderMessages() {
  if (!state.messages.length) {
    renderEmptyState();
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const message of state.messages) {
    const item = document.createElement('article');
    item.className = `message${message.authorId === state.me?.id ? ' is-mine' : ''}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.style.background = message.color || '#087f72';
    avatar.textContent = initials(message.authorName);

    const body = document.createElement('div');
    body.className = 'message-body';

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = message.authorName;

    const time = document.createElement('time');
    time.className = 'message-time';
    time.dateTime = message.createdAt;
    time.textContent = formatTime(message.createdAt);

    meta.append(author, time);

    if (message.department) {
      const department = document.createElement('span');
      department.className = 'message-department';
      department.textContent = message.department;
      meta.append(department);
    }

    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.text;

    body.append(meta, text);
    item.append(avatar, body);
    fragment.append(item);
  }

  elements.messageList.replaceChildren(fragment);
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function renderEmptyState() {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = 'Здесь пока нет сообщений. Начните обсуждение в этом канале.';
  elements.messageList.replaceChildren(empty);
}

function renderUsers() {
  if (!state.users.length) {
    elements.onlineList.textContent = 'Пока никого нет онлайн.';
    return;
  }

  elements.onlineList.replaceChildren(...state.users.map((user) => {
    const row = document.createElement('div');
    row.className = 'online-user';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = user.color || '#087f72';
    avatar.textContent = initials(user.name);

    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = user.name;
    const department = document.createElement('span');
    department.textContent = user.department || 'сотрудник';
    text.append(name, department);

    row.append(avatar, text);
    return row;
  }));
}

function renderTyping() {
  const users = [...state.typingUsers.values()].filter((user) => user.id !== state.me?.id);
  if (!users.length) {
    elements.typingLine.textContent = '';
    return;
  }

  const names = users.slice(0, 2).map((user) => user.name).join(', ');
  elements.typingLine.textContent = users.length > 2 ? `${names} и ещё кто-то печатают...` : `${names} печатает...`;
}

function renderProfile() {
  const displayName = state.me?.name || state.profile.name || 'Вы не вошли';
  elements.profileName.textContent = displayName;
  elements.profileDepartment.textContent = state.me?.department || state.profile.department || 'сотрудник';
  elements.profileAvatar.textContent = initials(displayName);
  elements.profileAvatar.style.background = state.me?.color || '#087f72';
}

function setConnectionStatus(text, isOnline) {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.classList.toggle('is-online', isOnline);
}

function scheduleReconnect() {
  if (!state.profile.name || elements.identityModal.classList.contains('is-visible')) {
    return;
  }

  const delay = Math.min(8000, 800 + state.reconnectAttempts * 900);
  state.reconnectAttempts += 1;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(connect, delay);
}

function sendSocket(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  state.socket.send(JSON.stringify(payload));
}

function autoSizeInput() {
  elements.messageInput.style.height = 'auto';
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 160)}px`;
}

function hydrateProfileForm() {
  elements.nameInput.value = state.profile.name || '';
  elements.departmentInput.value = state.profile.department || '';
  elements.companyCodeInput.value = state.profile.companyCode || '';
  elements.companyCodeLabel.classList.toggle('is-hidden', !state.requiresCode);
  renderProfile();
}

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem('messengerProfile')) || {};
  } catch {
    return {};
  }
}

function saveProfile() {
  localStorage.setItem('messengerProfile', JSON.stringify(state.profile));
}

function showError(message) {
  elements.formError.textContent = message;
}

function clearError() {
  elements.formError.textContent = '';
}

function initials(name) {
  return String(name || 'CM')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function formatTime(value) {
  return new Intl.DateTimeFormat('ru', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}
