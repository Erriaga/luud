'use strict';

const DEFAULT_AVATAR = '/assets/avatar.svg';
let accountUser = null;

const accountButton = document.getElementById('account-button');
const accountAvatar = document.getElementById('account-avatar');
const accountName = document.getElementById('account-name');
const accountDropdown = document.getElementById('account-dropdown');
const dropdownAccountName = document.getElementById('dropdown-account-name');
const dropdownAccountEmail = document.getElementById('dropdown-account-email');
const profileModal = document.getElementById('account-profile-modal');
const profileAvatarPreview = document.getElementById('profile-avatar-preview');
const profileEmail = document.getElementById('profile-account-email');
const profilePlayerName = document.getElementById('profile-player-name');
const profileStatus = document.getElementById('profile-status');

// O botão "Entrar" do canto superior direito só aparece com login Google
function setAccountAreaVisible(visible) {
  const area = document.getElementById('account-area');
  if (!area) return;
  area.classList.toggle('hidden', !visible);
}

function setAvatarImage(imageElement, url) {
  if (!imageElement) return;
  imageElement.onerror = () => {
    imageElement.onerror = null;
    imageElement.src = DEFAULT_AVATAR;
  };
  imageElement.src = url || DEFAULT_AVATAR;
}

// Nome exibido no site: sempre o NICKNAME (apelido) do jogador.
// O nome e sobrenome da conta Google nunca são exibidos.
function getAccountNickname(user) {
  const nickname = (user && (user.playerName || (user.email || '').split('@')[0])) || '';
  return String(nickname).trim();
}

function updateAccountUI(user) {
  if (!user) {
    accountUser = null;
    accountName.textContent = 'Entrar';
    setAvatarImage(accountAvatar, DEFAULT_AVATAR);
    dropdownAccountName.textContent = 'Conta';
    dropdownAccountEmail.textContent = 'Não conectado';
    // Sem login não existe botão de conta no canto superior direito
    setAccountAreaVisible(false);
    // Sincroniza a tela inicial do jogo com o estado "desconectado".
    if (typeof syncSetupLoginUI === 'function') syncSetupLoginUI();
    return;
  }

  accountUser = user;
  // No cabeçalho, ao lado da foto, aparece o nickname
  accountName.textContent = getAccountNickname(user) || 'Conta';
  setAvatarImage(accountAvatar, user.avatarUrl || user.picture || DEFAULT_AVATAR);
  dropdownAccountName.textContent = getAccountNickname(user) || 'Conta';
  dropdownAccountEmail.textContent = user.email || '';
  // Com login o botão de conta volta a aparecer no canto superior direito
  setAccountAreaVisible(true);
  // Sincroniza a tela inicial do jogo (esconde o login Google e habilita
  // o botão Single Player Online) assim que a sessão é carregada.
  if (typeof syncSetupLoginUI === 'function') syncSetupLoginUI();
}

function hideAccountDropdown() {
  accountDropdown.classList.add('hidden');
}

function handleAccountButtonClick(event) {
  event.stopPropagation();

  if (!accountUser) {
    window.location.href = '/';
    return;
  }

  accountDropdown.classList.toggle('hidden');
}

function openProfileModal() {
  hideAccountDropdown();

  if (!accountUser) {
    window.location.href = '/';
    return;
  }

  profileEmail.textContent = accountUser.email || '';
  // O nickname é apenas informativo: não pode ser alterado pelo jogador
  if (profilePlayerName) profilePlayerName.value = getAccountNickname(accountUser);
  setAvatarImage(profileAvatarPreview, accountUser.avatarUrl || accountUser.picture || DEFAULT_AVATAR);
  profileStatus.textContent = '';
  profileModal.classList.remove('hidden');
}

function closeProfileModal() {
  profileModal.classList.add('hidden');
}

// O nickname não pode mais ser alterado pelo jogador.
// A alteração será liberada apenas para contas pagas (mecânica em breve).

async function logoutAccount() {
  hideAccountDropdown();

  // No lobby ou durante a partida, a saída da página é bloqueada:
  // pede confirmação e só então encerra a sessão.
  if (typeof isPageExitBlocked === 'function' && isPageExitBlocked()) {
    const wantsToLeave = window.confirm('Você está no lobby ou em uma partida. Deseja realmente sair e encerrar a sessão?');
    if (!wantsToLeave) return;
    if (typeof allowPageExit === 'function') allowPageExit();
  }

  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    // Mesmo com falha de rede, o usuário é levado para a tela de login.
  }

  accountUser = null;
  window.location.href = '/';
}

async function loadAccountSession() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) {
      updateAccountUI(null);
      return;
    }

    const data = await response.json();
    if (!data.authenticated || !data.user) {
      updateAccountUI(null);
      return;
    }

    updateAccountUI(data.user);

    // Identifica a conexão WebSocket com esta conta (convites de partida,
    // solicitações de amizade e status online para os amigos)
    if (typeof identifyOnlineConnection === 'function') {
      identifyOnlineConnection(data.user.id);
    }

    const gameNameInput = document.getElementById('player-name-input');
    if (gameNameInput && !gameNameInput.value && data.user.playerName) {
      gameNameInput.value = data.user.playerName;
      if (typeof updatePlayerName === 'function') updatePlayerName(data.user.playerName);
    }
  } catch (error) {
    updateAccountUI(null);
  }
}

document.addEventListener('click', event => {
  if (!accountDropdown.classList.contains('hidden') && !accountButton.contains(event.target) && !accountDropdown.contains(event.target)) {
    hideAccountDropdown();
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    hideAccountDropdown();
    closeProfileModal();
  }
});

document.addEventListener('DOMContentLoaded', loadAccountSession);
