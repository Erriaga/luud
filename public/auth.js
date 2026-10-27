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
const profileForm = document.getElementById('profile-form');
const profileStatus = document.getElementById('profile-status');

function setAvatarImage(imageElement, url) {
  if (!imageElement) return;
  imageElement.onerror = () => {
    imageElement.onerror = null;
    imageElement.src = DEFAULT_AVATAR;
  };
  imageElement.src = url || DEFAULT_AVATAR;
}

function updateAccountUI(user) {
  if (!user) {
    accountUser = null;
    accountName.textContent = 'Entrar';
    setAvatarImage(accountAvatar, DEFAULT_AVATAR);
    dropdownAccountName.textContent = 'Conta';
    dropdownAccountEmail.textContent = 'Não conectado';
    return;
  }

  accountUser = user;
  accountName.textContent = user.displayName || user.playerName || 'Conta';
  setAvatarImage(accountAvatar, user.avatarUrl || user.picture || DEFAULT_AVATAR);
  dropdownAccountName.textContent = user.displayName || user.playerName || 'Conta';
  dropdownAccountEmail.textContent = user.email || '';
}

function hideAccountDropdown() {
  accountDropdown.classList.add('hidden');
}

function handleAccountButtonClick(event) {
  event.stopPropagation();

  if (!accountUser) {
    window.location.href = '/login';
    return;
  }

  accountDropdown.classList.toggle('hidden');
}

function openProfileModal() {
  hideAccountDropdown();

  if (!accountUser) {
    window.location.href = '/login';
    return;
  }

  profileEmail.textContent = accountUser.email || '';
  document.getElementById('profile-player-name').value = accountUser.playerName || '';
  setAvatarImage(profileAvatarPreview, accountUser.avatarUrl || accountUser.picture || DEFAULT_AVATAR);
  profileStatus.textContent = '';
  profileModal.classList.remove('hidden');
}

function closeProfileModal() {
  profileModal.classList.add('hidden');
}

async function saveProfile(event) {
  event.preventDefault();
  if (!accountUser) return;

  profileStatus.textContent = 'Salvando...';
  profileStatus.className = 'text-xs text-slate-400 min-h-[18px]';

  const payload = {
    playerName: document.getElementById('profile-player-name').value
  };

  try {
    const response = await fetch('/api/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Não foi possível salvar o perfil.');
    }

    const data = await response.json();
    updateAccountUI(data.user);

    const gameNameInput = document.getElementById('player-name-input');
    if (gameNameInput && !gameNameInput.value) {
      gameNameInput.value = data.user.playerName || '';
      if (typeof updatePlayerName === 'function') updatePlayerName(gameNameInput.value);
    }

    profileStatus.textContent = 'Perfil atualizado com sucesso!';
    profileStatus.className = 'text-xs text-emerald-400 min-h-[18px]';
    setTimeout(closeProfileModal, 700);
  } catch (error) {
    profileStatus.textContent = error.message;
    profileStatus.className = 'text-xs text-red-400 min-h-[18px]';
  }
}

async function logoutAccount() {
  hideAccountDropdown();

  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    // Mesmo com falha de rede, o usuário é levado para a tela de login.
  }

  accountUser = null;
  window.location.href = '/login';
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
