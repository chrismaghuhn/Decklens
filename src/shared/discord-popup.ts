
/**
 * DeckLens Discord Popup
 * 
 * Displays a dismissible popup to join the Discord community.
 * Persists the dismissed state in localStorage.
 */

const POPUP_ID = 'decklens-discord-popup';
const STORAGE_KEY = 'decklens-discord-popup-closed';
const DISCORD_URL = 'https://discord.gg/VVYhYnNjRk';

function createPopup() {
  if (localStorage.getItem(STORAGE_KEY) === 'true') {
    return;
  }

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    #${POPUP_ID} {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 10000;
      background: #18181c;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: 280px;
      font-family: 'Outfit', sans-serif;
      animation: slideIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
      backdrop-filter: blur(10px);
    }
    
    #${POPUP_ID} h3 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      color: #e2b340;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #${POPUP_ID} p {
      margin: 0;
      font-size: 14px;
      color: #9e96ab;
      line-height: 1.5;
    }

    #${POPUP_ID} .actions {
      display: flex;
      gap: 8px;
    }

    #${POPUP_ID} .btn {
      flex: 1;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
    }

    #${POPUP_ID} .btn-primary {
      background: #e2b340;
      color: #09090b;
      border: none;
    }

    #${POPUP_ID} .btn-primary:hover {
      background: #f0cc62;
    }

    #${POPUP_ID} .btn-secondary {
      background: transparent;
      color: #9e96ab;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    #${POPUP_ID} .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.05);
      color: #e2b340;
      border-color: #e2b340;
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    @media (max-width: 480px) {
      #${POPUP_ID} {
        bottom: 10px;
        right: 10px;
        left: 10px;
        width: auto;
      }
    }
  `;
  document.head.appendChild(style);

  // Create popup element
  const popup = document.createElement('div');
  popup.id = POPUP_ID;
  popup.innerHTML = `
    <h3>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.086 2.157 2.419 0 1.334-.956 2.42-2.157 2.42zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.086 2.157 2.419 0 1.334-.946 2.42-2.157 2.42z"/>
      </svg>
      Join the Community
    </h3>
    <p>Connect with other deck builders, get feedback, and share your creations!</p>
    <div class="actions">
      <button class="btn btn-secondary" id="${POPUP_ID}-close">Close</button>
      <a href="${DISCORD_URL}" target="_blank" class="btn btn-primary">Join Discord</a>
    </div>
  `;

  document.body.appendChild(popup);

  // Event listeners
  document.getElementById(`${POPUP_ID}-close`)?.addEventListener('click', () => {
    popup.remove();
    localStorage.setItem(STORAGE_KEY, 'true');
  });
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createPopup);
} else {
  createPopup();
}
