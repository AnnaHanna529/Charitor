(function () {
  const MAX_ITEMS = 4;
  const DURATION_MS = 4500;

  function getStack() {
    let stack = document.getElementById("siteNotifyStack");
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "siteNotifyStack";
      stack.className = "site-notify-stack";
      document.body.appendChild(stack);
    }
    return stack;
  }

  function notify(message, type) {
    if (!message) {
      return;
    }
    const stack = getStack();
    while (stack.children.length >= MAX_ITEMS) {
      stack.removeChild(stack.firstElementChild);
    }

    const node = document.createElement("div");
    node.className = "site-notify site-notify--" + (type || "info");
    node.textContent = message;
    stack.appendChild(node);

    setTimeout(() => {
      node.remove();
    }, DURATION_MS);
  }

  // Авто-остановка локального сервера, когда закрыта вкладка приложения.
  (function setupClientPresence() {
    if (!/^https?:\/\/localhost(?::\d+)?$/i.test(window.location.origin)) {
      return;
    }

    const key = "charitorClientTabId";
    let tabId = sessionStorage.getItem(key);
    if (!tabId) {
      tabId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, tabId);
    }

    const sendPresence = (action, useBeacon = false) => {
      const payload = JSON.stringify({ action, tabId });
      if (useBeacon && navigator.sendBeacon) {
        const blob = new Blob([payload], { type: "application/json" });
        navigator.sendBeacon("/client-presence", blob);
        return;
      }
      fetch("/client-presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    };

    sendPresence("open");
    const heartbeat = setInterval(() => sendPresence("heartbeat"), 10000);

    window.addEventListener("pagehide", () => {
      clearInterval(heartbeat);
      sendPresence("close", true);
    });
  })();

  // Мобильная нижняя панель навигации в стиле Janitor.
  (function setupMobileDock() {
    const path = window.location.pathname.toLowerCase();
    const isInternalPage = path.startsWith("/pages/");
    const isAdminPage = path.endsWith("/admin.html");
    const blocked =
      path.endsWith("/index.html") ||
      path.endsWith("/autorization.html") ||
      path.endsWith("/register.html") ||
      path.endsWith("/chat.html") ||
      path.includes("/pages/docs/");

    if (!isInternalPage || blocked) return;
    if (document.getElementById("mobileDockNav")) return;

    const dock = document.createElement("nav");
    dock.id = "mobileDockNav";
    dock.className = "mobile-dock-nav";
    dock.setAttribute("aria-label", "Нижняя навигация");

    const current = path;
    const isActive = (target) => current.endsWith(target);

    if (isAdminPage) {
      dock.innerHTML = `
        <a href="/pages/main.html" class="mobile-dock-item" aria-label="Главная">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3 3 10v10h6v-6h6v6h6V10l-9-7z" fill="currentColor" />
          </svg>
        </a>
        <button type="button" class="mobile-dock-item mobile-dock-admin-tab active" data-admin-tab="usersTab" aria-label="Пользователи">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.7 0-6 1.4-6 4v1h8v-1c0-1.1.4-2.1 1.2-3-1-.6-2.2-1-3.2-1zm8 0c-2.9 0-7 1.5-7 4v1h14v-1c0-2.5-4.1-4-7-4z" fill="currentColor"/>
          </svg>
        </button>
        <a href="/pages/main.html" class="mobile-dock-center" aria-label="Главная">
          <img src="/img/icon.svg" alt="Главная" />
        </a>
        <a href="/pages/history.html" class="mobile-dock-item" aria-label="История">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 4h12v9H7l-3 3V4zm14 0h2v12h-6v-2h4V4z" fill="currentColor" />
          </svg>
        </a>
        <a href="/pages/profile.html" class="mobile-dock-item" aria-label="Профиль">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5z" fill="currentColor" />
          </svg>
        </a>
      `;
    } else {
      dock.innerHTML = `
        <a href="/pages/main.html" class="mobile-dock-item ${isActive("/main.html") ? "active" : ""}" aria-label="Главная">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3 3 10v10h6v-6h6v6h6V10l-9-7z" fill="currentColor" />
          </svg>
        </a>
        <a href="/pages/search.html" class="mobile-dock-item ${isActive("/search.html") ? "active" : ""}" aria-label="Поиск">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15.5 14h-.8l-.3-.3a6 6 0 1 0-.7.7l.3.3v.8L19 20.2 20.2 19 15.5 14zm-5.5 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" fill="currentColor" />
          </svg>
        </a>
        <a href="/pages/main.html" class="mobile-dock-center ${isActive("/main.html") ? "active" : ""}" aria-label="Главная">
          <img src="/img/icon.svg" alt="Главная" />
        </a>
        <a href="/pages/history.html" class="mobile-dock-item ${isActive("/history.html") ? "active" : ""}" aria-label="История">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 4h12v9H7l-3 3V4zm14 0h2v12h-6v-2h4V4z" fill="currentColor" />
          </svg>
        </a>
        <a href="/pages/profile.html" class="mobile-dock-item ${isActive("/profile.html") ? "active" : ""}" aria-label="Профиль">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5z" fill="currentColor" />
          </svg>
        </a>
      `;
    }

    document.body.classList.add("has-mobile-dock");
    document.body.appendChild(dock);

    if (isAdminPage) {
      const adminTabs = Array.from(
        dock.querySelectorAll(".mobile-dock-admin-tab"),
      );
      const syncAdminDockState = () => {
        const activeTab = document.querySelector(".admin-tab.active");
        const activeId = activeTab ? activeTab.id : "usersTab";
        adminTabs.forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.adminTab === activeId);
        });
      };

      adminTabs.forEach((btn) => {
        btn.addEventListener("click", () => {
          const targetTab = btn.dataset.adminTab;
          const targetSidebarBtn = document.querySelector(
            `.sidebar-btn[data-tab="${targetTab}"]`,
          );
          if (targetSidebarBtn) {
            targetSidebarBtn.click();
          } else {
            document.querySelectorAll(".admin-tab").forEach((tab) => {
              tab.classList.toggle("active", tab.id === targetTab);
            });
          }
          syncAdminDockState();
        });
      });

      syncAdminDockState();
    }
  })();

  window.notifyUser = notify;

  // Центр уведомлений о событиях (подписки, избранное, новые персонажи).
  (function setupEventNotificationsCenter() {
    const path = window.location.pathname.toLowerCase();
    const blocked =
      path.endsWith("/index.html") ||
      path.endsWith("/autorization.html") ||
      path.endsWith("/register.html") ||
      path.includes("/pages/docs/");

    if (blocked) return;

    const savedUserRaw = localStorage.getItem("user");
    if (!savedUserRaw) return;

    let savedUser;
    try {
      savedUser = JSON.parse(savedUserRaw);
    } catch {
      return;
    }
    if (!savedUser?.id) return;

    const host =
      document.querySelector(".topbar-right") ||
      document.querySelector(".chat-topbar-right");
    if (!host || host.querySelector(".event-notify-wrap")) return;

    const apiBase =
      typeof window.API_BASE === "string" && window.API_BASE
        ? window.API_BASE
        : "";

    const wrap = document.createElement("div");
    wrap.className = "event-notify-wrap";
    wrap.innerHTML = `
      <button type="button" class="top-icon event-notify-btn" aria-label="Уведомления" aria-expanded="false">
        <svg class="topbar-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 22a2.2 2.2 0 0 0 2.15-1.75H9.85A2.2 2.2 0 0 0 12 22zm6.3-5.5V11a6.3 6.3 0 0 0-5-6.16V4a1 1 0 1 0-2 0v.84A6.3 6.3 0 0 0 6.7 11v5.5L5 18.2h14l-1.7-1.7z" fill="currentColor"/>
        </svg>
        <span class="event-notify-badge hidden" aria-hidden="true">0</span>
      </button>
      <div class="event-notify-panel hidden" role="dialog" aria-label="Уведомления о событиях">
        <div class="event-notify-head">
          <strong>Уведомления</strong>
          <button type="button" class="event-notify-read-all">Прочитать все</button>
        </div>
        <div class="event-notify-list"></div>
      </div>
    `;

    const profileLink = host.querySelector(".profile-mini");
    if (profileLink) {
      host.insertBefore(wrap, profileLink);
    } else {
      host.appendChild(wrap);
    }

    const btn = wrap.querySelector(".event-notify-btn");
    const panel = wrap.querySelector(".event-notify-panel");
    const list = wrap.querySelector(".event-notify-list");
    const badge = wrap.querySelector(".event-notify-badge");
    const readAllBtn = wrap.querySelector(".event-notify-read-all");

    function escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text ?? "";
      return div.innerHTML;
    }

    function formatWhen(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function getNotificationLink(item) {
      if (item.type === "follow" && item.actor_id) {
        return `/pages/profile.html?authorId=${encodeURIComponent(item.actor_id)}`;
      }
      if (item.bot_id) {
        return `/pages/bot.html?id=${encodeURIComponent(item.bot_id)}`;
      }
      return "";
    }

    function setPanelOpen(open) {
      panel.classList.toggle("hidden", !open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function renderNotifications(items, unreadCount) {
      const count = Number(unreadCount || 0);
      badge.textContent = String(count);
      badge.classList.toggle("hidden", count <= 0);

      if (!items.length) {
        list.innerHTML = `<p class="event-notify-empty">Пока нет уведомлений</p>`;
        return;
      }

      list.innerHTML = items
        .map((item) => {
          const href = getNotificationLink(item);
          const unread = Number(item.is_read) === 0;
          const inner = `
            <span class="event-notify-item-text">${escapeHtml(item.message || "Событие")}</span>
            <span class="event-notify-item-time">${escapeHtml(formatWhen(item.created_at))}</span>
          `;
          if (href) {
            return `<a href="${href}" class="event-notify-item${unread ? " is-unread" : ""}" data-id="${Number(item.id)}">${inner}</a>`;
          }
          return `<div class="event-notify-item${unread ? " is-unread" : ""}" data-id="${Number(item.id)}">${inner}</div>`;
        })
        .join("");
    }

    async function loadNotifications() {
      try {
        const response = await fetch(
          `${apiBase}/event-notifications/${encodeURIComponent(savedUser.id)}?limit=20`,
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return;
        renderNotifications(data.notifications || [], data.unread_count || 0);
      } catch {
        /* ignore */
      }
    }

    async function markAllRead() {
      try {
        await fetch(
          `${apiBase}/event-notifications/${encodeURIComponent(savedUser.id)}/read`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        await loadNotifications();
      } catch {
        /* ignore */
      }
    }

    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = panel.classList.contains("hidden");
      setPanelOpen(willOpen);
      if (willOpen) {
        loadNotifications();
      }
    });

    readAllBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      markAllRead();
    });

    list.addEventListener("click", (event) => {
      const target = event.target.closest(".event-notify-item[data-id]");
      if (!target) return;
      const notificationId = Number(target.dataset.id);
      if (!Number.isFinite(notificationId) || notificationId < 1) return;
      fetch(
        `${apiBase}/event-notifications/${encodeURIComponent(savedUser.id)}/read`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notification_id: notificationId }),
        },
      ).catch(() => {});
    });

    document.addEventListener("click", (event) => {
      if (!wrap.contains(event.target)) {
        setPanelOpen(false);
      }
    });

    loadNotifications();
    setInterval(loadNotifications, 60000);
    window.refreshEventNotifications = loadNotifications;
  })();
})();
