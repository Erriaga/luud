'use strict';

const DEFAULT_AVATAR = '/assets/avatar.svg';
let accountUser = null;

const accountAvatar = document.getElementById('account-avatar');
const accountName = document.getElementById('account-name');
const accountMenuName = document.getElementById('account-menu-name');
const accountMenuEmail = document.getElementById('account-menu-email');
const profileModal = document.getElementById('account-profile-modal');
const profileAvatarPreview = document.getElementById('profile-avatar-preview');
const profileEmail = document.getElementById('profile-account-email');
const profilePlayerName = document.getElementById('profile-player-name');
const profileStatus = document.getElementById('profile-status');

// Selos do plano da conta exibidos junto do nickname
// (cabeçalho, painel do menu e modal de perfil)
const premiumBadges = [
  document.getElementById('account-premium-badge'),
  document.getElementById('account-menu-premium-badge'),
  document.getElementById('profile-premium-badge')
];

const freeBadges = [
  document.getElementById('account-free-badge'),
  document.getElementById('account-menu-free-badge'),
  document.getElementById('profile-free-badge')
];

// O botão "Entrar" do canto superior direito só aparece com login Google
function setAccountAreaVisible(visible) {
  const area = document.getElementById('account-area');
  if (!area) return;
  area.classList.toggle('hidden', !visible);
  // Na tela inicial o botão fica centralizado abaixo da logo: o espaço
  // reservado some junto quando não há conta conectada.
  const slot = document.getElementById('setup-account-slot');
  if (slot) slot.classList.toggle('hidden', !visible);
}

// Conta com o plano Premium liberado (pagamento único vitalício)
function isPremiumAccount(user) {
  if (!user) return false;
  return Boolean(
    user.isPaid || user.paid || user.hasPaidPlan || user.subscription ||
    user.plan === 'paid' || user.plan === 'premium'
  );
}

function updatePremiumBadges(user) {
  const logged = Boolean(user);
  const visible = isPremiumAccount(user);
  // Premium: selo amarelo; conta gratuita: selo preto
  premiumBadges.forEach(badge => {
    if (badge) badge.classList.toggle('hidden', !visible);
  });
  freeBadges.forEach(badge => {
    if (badge) badge.classList.toggle('hidden', !logged || visible);
  });
  // O atalho "Premium" do menu só faz sentido para quem ainda não tem
  // o plano: conta Premium enxerga os benefícios dentro do próprio menu.
  // O cartão é desenhado na grade do menu, então a grade é redesenhada.
  if (typeof renderAccountMenuGrid === 'function') renderAccountMenuGrid();
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
    accountMenuName.textContent = 'Conta';
    accountMenuEmail.textContent = 'Não conectado';
    updatePremiumBadges(null);
    // Sem login não existe tier de Liga para exibir
    if (typeof renderProfileLeagueTier === 'function') renderProfileLeagueTier(null);
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
  accountMenuName.textContent = getAccountNickname(user) || 'Conta';
  accountMenuEmail.textContent = user.email || '';
  // Selo Premium (conta paga)
  updatePremiumBadges(user);
  // Loja: carrega o inventário e a carteira (Ludas e Cristais)
  if (typeof loadShop === 'function') {
    loadShop().then(() => {
      if (typeof applyNicknameEditingState === 'function') {
        applyNicknameEditingState(accountCanEditNickname());
      }
    });
  }
  // Com login o botão de conta volta a aparecer no canto superior direito
  setAccountAreaVisible(true);
  // Tier da Liga (apenas para contas Premium)
  if (isPremiumAccount(user) && typeof loadLeagueStanding === 'function') {
    loadLeagueStanding();
  }
  // Sincroniza a tela inicial do jogo (esconde o login Google e habilita
  // o botão Single Player Online) assim que a sessão é carregada.
  if (typeof syncSetupLoginUI === 'function') syncSetupLoginUI();
}

// Fecha o painel do menu da conta (o painel em grade é desenhado
// em game.html; aqui só garante o fechamento).
function hideAccountMenu() {
  if (typeof closeAccountMenu === 'function') {
    closeAccountMenu();
    return;
  }
  const modal = document.getElementById('account-menu-modal');
  if (modal) modal.classList.add('hidden');
}

function handleAccountButtonClick(event) {
  event.stopPropagation();

  if (!accountUser) {
    window.location.href = '/';
    return;
  }

  if (typeof openAccountMenu === 'function') {
    openAccountMenu();
  }
}

function openProfileModal() {
  hideAccountMenu();

  if (!accountUser) {
    window.location.href = '/';
    return;
  }

  profileEmail.textContent = accountUser.email || '';
  // O nickname só pode ser alterado por contas Premium ou por quem tem
  // uma renomeação comprada na loja (item PRO-008)
  if (profilePlayerName) profilePlayerName.value = getAccountNickname(accountUser);
  applyNicknameEditingState(accountCanEditNickname());
  setAvatarImage(profileAvatarPreview, accountUser.avatarUrl || accountUser.picture || DEFAULT_AVATAR);
  profileStatus.textContent = '';
  // Carrega as cores do perfil (primária, secundária e terciária)
  if (typeof initProfileColors === 'function') initProfileColors(accountUser);
  // Tier da Liga (apenas para contas Premium)
  if (typeof loadLeagueStanding === 'function') loadLeagueStanding();
  // Bloco da Conta Premium (preço e benefícios)
  if (typeof loadPremiumInfo === 'function') loadPremiumInfo().then(() => {
    if (typeof renderPremiumBox === 'function') renderPremiumBox(accountUser);
  });
  if (typeof renderPremiumBox === 'function') renderPremiumBox(accountUser);
  profileModal.classList.remove('hidden');
}

function closeProfileModal() {
  profileModal.classList.add('hidden');
  // As alterações de cor que não foram salvas são descartadas
  if (typeof discardProfileColorChanges === 'function') discardProfileColorChanges();
  // Fecha também o polling do pagamento Pix (aberto no checkout):
  // fechar o perfil encerra a espera — o intervalo de 4s não pode
  // continuar rodando em segundo plano
  if (typeof stopPremiumPolling === 'function') stopPremiumPolling();
}

// Habilita (Premium ou renomeação comprada na loja) ou bloqueia a edição do nickname
function applyNicknameEditingState(editable) {
  const canEdit = editable === undefined
    ? accountCanEditNickname()
    : Boolean(editable);
  const saveBtn = document.getElementById('profile-save-name-btn');

  if (profilePlayerName) {
    profilePlayerName.readOnly = !canEdit;
    profilePlayerName.setAttribute('aria-readonly', String(!canEdit));
    profilePlayerName.tabIndex = canEdit ? 0 : -1;
    profilePlayerName.classList.toggle('profile-editable', canEdit);
  }

  if (saveBtn) saveBtn.classList.toggle('hidden', !canEdit);
}

// O nickname pode ser alterado por contas Premium e por quem tem uma
// renomeação comprada na loja (item PRO-008).
function accountCanEditNickname() {
  if (isPremiumAccount(typeof accountUser !== 'undefined' ? accountUser : null)) return true;
  const data = typeof shopData !== 'undefined' ? shopData : null;
  if (!data || !data.inventory) return false;
  return (Number(data.inventory.renameTokens) || 0) > 0;
}

// O nickname não pode ser alterado por contas gratuitas:
// a edição é liberada para as contas Premium (ver applyNicknameEditingState).

async function logoutAccount() {
  hideAccountMenu();

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
      // Convite por link (roadmap #15): avisa que é preciso entrar na conta
      if (typeof handleInviteLink === 'function') {
        handleInviteLink();
      }
      return;
    }

    updateAccountUI(data.user);

    // Avisa se há recompensa esperando (baú do dia ou missão concluída)
    if (typeof refreshRewardsBadge === 'function') {
      refreshRewardsBadge();
    }

    // Convite por link (roadmap #15): com a sessão ativa, entra na sala
    // que veio na URL (?sala=CODIGO) sem precisar digitar o código
    if (typeof handleInviteLink === 'function') {
      handleInviteLink();
    }

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

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    hideAccountMenu();
    closeProfileModal();
    if (typeof closeSeasonModal === 'function') {
      closeSeasonModal();
    }
    if (typeof closeTournamentModal === 'function') {
      closeTournamentModal();
    }
    if (typeof hideRematchOffer === 'function') {
      hideRematchOffer();
    }
    if (typeof closePremiumBenefits === 'function') {
      closePremiumBenefits();
    }
  }
});

document.addEventListener('DOMContentLoaded', loadAccountSession);
