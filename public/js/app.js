const App = {
  el: null,
  currentUser: null,
  searchTimeout: null,
  cache: { categories: [], tags: [], materials: [], users: [] },
  pendingFiles: [],
  selectedModelIds: [],
  lastSelectedModelId: null,
  selectedBrowsePaths: [],
  versionInfo: null,
  libraryViewMode: 'grid',

  // ── Iniciar ──
  async init() {
    this.el = document.getElementById('app');
    const savedUser = localStorage.getItem('pv_user');
    if (savedUser) {
      try { this.currentUser = JSON.parse(savedUser); } catch(e) { localStorage.removeItem('pv_user'); }
    }
    
    if (this.currentUser) {
      try {
        const user = await API.getMe();
        if (user && user.csrfToken) {
          localStorage.setItem('pv_csrf_token', user.csrfToken);
          this.currentUser = user;
          localStorage.setItem('pv_user', JSON.stringify(user));
        } else {
          localStorage.removeItem('pv_user');
          localStorage.removeItem('pv_csrf_token');
          this.currentUser = null;
        }
      } catch (e) {
        localStorage.removeItem('pv_user');
        localStorage.removeItem('pv_csrf_token');
        this.currentUser = null;
      }
    }
    
    try {
      this.publicConfig = await API.getPublicConfig();
    } catch(e) { this.publicConfig = {}; }

    // Retomar automaticamente a monitorização da análise se estiver ativa em segundo plano
    if (this.currentUser && this.currentUser.role === 'admin') {
      fetch('/api/library/scan/status', { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : null)
        .then(status => {
          if (status && status.isScanning) {
            this.monitorScanProgress();
          }
        })
        .catch(() => {});
    }
    
    if (this.publicConfig.require_login_to_view && !this.currentUser) {
      document.getElementById('app').innerHTML = '<div style="height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg-color)"><h1 style="margin-bottom:20px">GyroidVault</h1><button class="btn btn-primary btn-lg" onclick="App.showLogin()">Iniciar Sessão para Aceder ao GyroidVault</button></div>';
      this.showLogin();
      return;
    }
    
    window.addEventListener('hashchange', () => this.route());
    
    // Configurar atalhos de teclado (Ctrl+K para pesquisa, Ctrl+B para alternar a barra lateral)
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const input = document.getElementById('topbar-search-input') || document.getElementById('search-input');
        if (input) { input.focus(); input.select(); }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        this.toggleSidebarCollapse();
      }
    });

    // Restaurar o estado de colapso da barra lateral
    const savedCollapsed = localStorage.getItem('gv_sidebar_collapsed') === 'true';
    if (savedCollapsed) {
      document.getElementById('app-sidebar')?.classList.add('collapsed');
      document.body.classList.add('sidebar-collapsed');
    }

    await this.loadCache();
    await this.loadViewMode();
    this.renderSidebarCategories();
    this.renderSidebarCollections();
    this.checkUpdates();
    this.updateUserNav();
    this.updateThemeIcon();
    this.initPrinters();
    this.route();
  },

  checkWhatsNew() {
    const CURRENT_VERSION = '2.0.2';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const seenVersion = localStorage.getItem('gv_last_seen_version');
    
    // Durante testes locais no localhost, mostrar sempre ao carregar a página para poder ser testado repetidamente
    // Em produção (Unraid/Docker/ao vivo), mostrar apenas uma vez até ser dispensado
    if (isLocalhost || seenVersion !== CURRENT_VERSION) {
      setTimeout(() => {
        this.openWhatsNew();
      }, 500);
    }
  },

  async openWhatsNew() {
    try {
      const res = await API.getReleaseNotes().catch(() => ({ notes: [] }));
      this.cachedReleaseNotes = res.notes || [];
      this.openModal('Bem-vindo ao GyroidVault 2.0', UI.whatsNewModal('2.0.0', this.cachedReleaseNotes), 'modal-lg');
    } catch (e) {
      this.openModal('Bem-vindo ao GyroidVault 2.0', UI.whatsNewModal('2.0.0', []), 'modal-lg');
    }
  },

  switchWhatsNewTab(tab) {
    const highlightsContent = document.getElementById('whatsnew-content-highlights');
    const changelogContent = document.getElementById('whatsnew-content-changelog');
    const highlightsBtn = document.getElementById('whatsnew-tab-btn-highlights');
    const changelogBtn = document.getElementById('whatsnew-tab-btn-changelog');

    if (tab === 'highlights') {
      if (highlightsContent) highlightsContent.style.display = 'block';
      if (changelogContent) changelogContent.style.display = 'none';
      if (highlightsBtn) highlightsBtn.classList.add('active');
      if (changelogBtn) changelogBtn.classList.remove('active');
    } else {
      if (highlightsContent) highlightsContent.style.display = 'none';
      if (changelogContent) changelogContent.style.display = 'block';
      if (highlightsBtn) highlightsBtn.classList.remove('active');
      if (changelogBtn) changelogBtn.classList.add('active');
    }
  },

  selectWhatsNewVersion(ver) {
    const note = (this.cachedReleaseNotes || []).find(n => n.version === ver);
    const body = document.getElementById('whatsnew-changelog-body');
    if (note && body) {
      body.innerHTML = UI.renderMarkdown(note.content);
    }
    document.querySelectorAll('.changelog-version-pill').forEach(btn => {
      btn.classList.remove('active');
    });
    const activeBtn = document.getElementById(`whatsnew-ver-${ver.replace(/\./g, '-')}`);
    if (activeBtn) {
      activeBtn.classList.add('active');
    }
  },

  dismissWhatsNew() {
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocalhost) {
      localStorage.setItem('gv_last_seen_version', '2.0.0');
    }
    this.closeModal();
  },

  toggleSidebarCollapse() {
    const sidebar = document.getElementById('app-sidebar');
    if (!sidebar) return;
    const isCollapsed = sidebar.classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed', isCollapsed);
    localStorage.setItem('gv_sidebar_collapsed', isCollapsed);
  },

  toggleMobileSidebar(force = null) {
    const sidebar = document.getElementById('app-sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar) return;
    const isOpen = force !== null ? force : !sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open', isOpen);
    if (backdrop) backdrop.classList.toggle('active', isOpen);
  },

  renderSidebarCategories() {
    const list = document.getElementById('sidebar-categories-list');
    const group = document.getElementById('sidebar-categories-group');
    if (!list) return;
    if (!this.cache.categories || this.cache.categories.length === 0) {
      if (group) group.style.display = 'none';
      return;
    }
    if (group) group.style.display = 'flex';
    list.innerHTML = this.cache.categories.slice(0, 10).map(c => `
      <a href="#/models?category=${c.id}" class="sidebar-sub-item" title="${c.name}">
        <span class="dot" style="background:${c.color || 'var(--accent-cyan)'}"></span>
        <span>${c.name}</span>
      </a>
    `).join('');
  },

  async renderSidebarCollections() {
    const list = document.getElementById('sidebar-collections-list');
    const group = document.getElementById('sidebar-collections-group');
    if (!list) return;
    if (!this.currentUser) {
      if (group) group.style.display = 'none';
      return;
    }
    try {
      const projects = await API.getProjects();
      if (!projects || projects.length === 0) {
        list.innerHTML = `<span style="font-size:0.75rem;color:var(--text-muted);padding:4px 10px;font-style:italic">Ainda sem coleções</span>`;
        if (group) group.style.display = 'flex';
        return;
      }
      if (group) group.style.display = 'flex';
      list.innerHTML = projects.slice(0, 8).map(p => `
        <a href="#/projects/${p.id}" class="sidebar-sub-item" title="${p.name} (${p.model_count || 0} models)">
          <span style="display:inline-flex;align-items:center;color:${p.visibility === 'private' ? 'var(--accent-purple)' : '#f59e0b'};opacity:0.95">
            ${p.visibility === 'private'
              ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
              : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
            }
          </span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${p.name}</span>
          <span style="font-size:0.65rem;color:var(--text-muted)">${p.model_count || 0}</span>
        </a>
      `).join('');
    } catch(e) {
      if (group) group.style.display = 'none';
    }
  },

  handleTopSearch(query) {
    clearTimeout(this.topSearchTimeout);
    this.topSearchTimeout = setTimeout(() => {
      const q = (query || '').trim();
      if (location.hash.startsWith('#/models')) {
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
          searchInput.value = q;
          this.handleFilter();
        } else {
          this.navigate(q ? `/models?search=${encodeURIComponent(q)}` : '/models');
        }
      } else if (location.hash.startsWith('#/collections') || location.hash.startsWith('#/projects')) {
        this.collectionsSearchQuery = q;
        this.updateCollectionsGrid();
      } else if (q) {
        this.navigate(`/models?search=${encodeURIComponent(q)}`);
      }
    }, 200);
  },

  async initPrinters() {
    if (!this.currentUser || this.currentUser.role !== 'admin') return;
    try {
      const config = await API.getSystemSettings();
      if (!config.printers) return;
      const printers = JSON.parse(config.printers);
      if (!printers || printers.length === 0) return;
      
      const container = document.getElementById('nav-printers-widget');
      if (!container) return;
      
      this.printerSockets = this.printerSockets || {};
      this.printerStatus = this.printerStatus || {};
      
      container.innerHTML = printers.map(p => `
        <div id="printer-widget-${p.id}" class="sidebar-printer-card">
          <div class="sidebar-printer-header">
            <span style="display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis">
              <span class="status-dot" style="width:6px;height:6px;border-radius:50%;background:var(--text-muted);display:inline-block;flex-shrink:0"></span>
              <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</span>
            </span>
          </div>
          <div class="sidebar-printer-temps" style="display:none">
            <span class="nozzle-temp">N: --°C</span>
            <span class="bed-temp">B: --°C</span>
          </div>
        </div>
      `).join('');
      
      printers.forEach(p => {
        if (this.printerSockets[p.id]) return;
        
        try {
          const wsUrl = new URL('/websocket', p.url);
          wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(wsUrl.toString());
          this.printerSockets[p.id] = ws;
          
          ws.onopen = () => {
            const widget = document.getElementById(`printer-widget-${p.id}`);
            if(widget) {
              const dot = widget.querySelector('.status-dot');
              if (dot) dot.style.background = 'var(--accent-green)';
              const temps = widget.querySelector('.sidebar-printer-temps');
              if (temps) temps.style.display = 'flex';
            }
            // Subscrever atualizações de temperatura
            ws.send(JSON.stringify({
              jsonrpc: "2.0",
              method: "printer.objects.subscribe",
              params: {
                objects: {
                  extruder: ["temperature", "target"],
                  heater_bed: ["temperature", "target"]
                }
              },
              id: 1
            }));
          };
          
          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              if (msg.method === 'notify_status_update' && msg.params && msg.params[0]) {
                const status = msg.params[0];
                const widget = document.getElementById(`printer-widget-${p.id}`);
                if (!widget) return;
                
                if (status.extruder && status.extruder.temperature !== undefined) {
                  const nt = widget.querySelector('.nozzle-temp');
                  if (nt) nt.innerText = `N: ${Math.round(status.extruder.temperature)}°C`;
                }
                if (status.heater_bed && status.heater_bed.temperature !== undefined) {
                  const bt = widget.querySelector('.bed-temp');
                  if (bt) bt.innerText = `B: ${Math.round(status.heater_bed.temperature)}°C`;
                }
              }
              if (msg.id === 1 && msg.result && msg.result.status) {
                // Resposta inicial
                const status = msg.result.status;
                const widget = document.getElementById(`printer-widget-${p.id}`);
                if (!widget) return;
                if (status.extruder) {
                  const nt = widget.querySelector('.nozzle-temp');
                  if (nt) nt.innerText = `N: ${Math.round(status.extruder.temperature)}°C`;
                }
                if (status.heater_bed) {
                  const bt = widget.querySelector('.bed-temp');
                  if (bt) bt.innerText = `B: ${Math.round(status.heater_bed.temperature)}°C`;
                }
              }
            } catch(e){}
          };
          
          ws.onclose = () => {
            const widget = document.getElementById(`printer-widget-${p.id}`);
            if(widget) {
              const dot = widget.querySelector('.status-dot');
              if (dot) dot.style.background = 'var(--error)';
              widget.querySelector('.printer-temps').style.display = 'none';
            }
            delete this.printerSockets[p.id];
          };
        } catch(e) {
          console.error('Falha ao ligar à WS da impressora', p.url, e);
        }
      });
    } catch(err) { console.error('Falha ao iniciar impressoras', err); }
  },

  async checkUpdates() {
    try {
      const info = await API.getUpdateStatus();
      if (info) {
        this.versionInfo = info;
        const verEl = document.getElementById('app-version');
        if (verEl) verEl.textContent = `v${info.currentVersion}`;
        
        if (info.hasUpdate) {
          const badge = document.getElementById('update-badge');
          if (badge) badge.style.display = 'inline-flex';
        }
      }
    } catch(e) { console.warn('Falha na verificação de atualizações', e); }
  },

  showUpdateInfo() {
    if (this.versionInfo) {
      this.openModal('Atualização Disponível', UI.aboutSection(this.versionInfo));
    }
  },

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || localStorage.getItem('gv_theme') || 'glass';
    const nextTheme = current === 'light' ? 'glass' : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('gv_theme', nextTheme);
    this.updateThemeIcon();
  },

  updateThemeIcon() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    btn.innerHTML = isLight 
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
    btn.title = isLight ? "Mudar para Modo Escuro" : "Mudar para Modo Claro";
  },

  async loadCache() {
    try {
      const [cats, tags, mats] = await Promise.all([
        API.getCategories(), API.getTags(), API.getMaterials()
      ]);
      this.cache.categories = cats || [];
      this.cache.tags = tags || [];
      this.cache.materials = mats || [];
      
      // Só tentar obter utilizadores se autenticado
      if (this.currentUser) {
        try {
          this.cache.users = await API.getUsers();
        } catch(e) { /* o utilizador pode não ter permissões, ignorar */ }
      }
    } catch (e) { console.error('Falha ao carregar cache:', e); }
  },

  async loadViewMode() {
    try {
      const res = await API.getViewMode();
      if (res) this.libraryViewMode = res.library_view_mode || 'grid';
    } catch(e) { /* predefinição: grelha */ }
  },

  // ── Rotas ──
  route() {
    const hash = location.hash.slice(1) || '/';
    const [path, query] = hash.split('?');
    const params = new URLSearchParams(query || '');

    this.toggleMobileSidebar(false);

    const links = document.querySelectorAll('.sidebar-nav-item, .sidebar-sub-item');
    links.forEach(l => l.classList.remove('active'));
    
    // Limpar seleção ao navegar
    this.selectedModelIds = [];
    this.selectedBrowsePaths = [];
    this.renderBulkBar();
    this.renderBulkBrowseBar();

    if (path === '/' || path === '/dashboard') {
      document.getElementById('nav-dashboard')?.classList.add('active');
      this.renderDashboard();
    } else if (path === '/models') {
      document.getElementById('nav-models')?.classList.add('active');
      this.renderModels(Object.fromEntries(params));
    } else if (path.startsWith('/models/')) {
      document.getElementById('nav-models')?.classList.add('active');
      this.renderModelDetail(path.split('/')[2]);
    } else if (path === '/projects' || path === '/collections') {
      document.getElementById('nav-collections')?.classList.add('active');
      this.renderProjects();
    } else if (path.startsWith('/projects/') || path.startsWith('/collections/')) {
      document.getElementById('nav-collections')?.classList.add('active');
      this.renderProjectDetail(path.split('/')[2]);
    } else if (path.startsWith('/share/')) {
      this.renderSharedModel(path.split('/')[2]);
    } else if (path === '/profile') {
      this.renderProfile();
    } else if (path === '/settings') {
      if (!this.currentUser || this.currentUser.role !== 'admin') {
        this.toast('É necessário acesso de administrador', 'error');
        this.navigate('/');
        return;
      }
      document.getElementById('nav-settings')?.classList.add('active');
      this.renderSettings(params.get('tab') || 'categories');
    } else if (path === '/register') {
      this.showRegister(params.get('token') || params.get('invite'));
    } else if (path === '/reset-password') {
      this.showResetPassword(params.get('token'));
    } else {
      this.renderDashboard();
    }
  },

  navigate(path) {
    location.hash = path;
  },

  previewTheme() {
    const t = document.getElementById('theme-selector').value;
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('gv_theme', t);
  },

  setAccent(a) {
    document.documentElement.setAttribute('data-accent', a);
    localStorage.setItem('gv_accent', a);
  },

  // ── Notificações ──
  toast(msg, type = 'success') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
  },

  // ── Modal ──
  openModal(title, content, modalClass = '') {
    const modal = document.getElementById('modal');
    if (modal) {
      modal.className = 'modal' + (modalClass ? ` ${modalClass}` : '');
    }
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = content;
    document.getElementById('modal-overlay').classList.add('active');

    // Guardar o estado inicial do formulário para verificar alterações não guardadas ao fechar
    setTimeout(() => {
      const form = document.querySelector('#modal-body form');
      if (form) {
        this.initialModalFormSnapshot = new URLSearchParams(new FormData(form)).toString();
      } else {
        this.initialModalFormSnapshot = null;
      }
    }, 50);
  },

  isModalFormDirty() {
    const form = document.querySelector('#modal-body form');
    if (!form) return false;
    if (this.pendingFiles && this.pendingFiles.length > 0) return true;
    if (this.initialModalFormSnapshot !== null) {
      const currentSnapshot = new URLSearchParams(new FormData(form)).toString();
      return currentSnapshot !== this.initialModalFormSnapshot;
    }
    return false;
  },

  dismissModal() {
    if (this.isModalFormDirty()) {
      if (!confirm('Tem alterações não guardadas. Tem a certeza de que quer fechar e descartá-las?')) {
        return;
      }
    }
    this.closeModal();
  },

  closeModal() {
    const title = document.getElementById('modal-title')?.textContent || '';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocalhost && (title.includes('GyroidVault 2.0') || title.includes('GyroidVault v2'))) {
      localStorage.setItem('gv_last_seen_version', '2.0.0');
    }
    document.getElementById('modal-overlay').classList.remove('active');
    const modal = document.getElementById('modal');
    if (modal) {
      modal.className = 'modal';
    }
    this.initialModalFormSnapshot = null;
  },

  // ─── Painel ────────────────────────────────────────────────────────
  async renderDashboard() {
    this.el.innerHTML = `<div class="page-header"><div><h1 class="page-title">Painel</h1><p class="page-subtitle">A sua visão geral de impressão 3D</p></div></div><div class="stats-grid"><div class="stat-card"><div class="skeleton" style="width:60%;height:32px;margin-top:40px"></div></div><div class="stat-card"><div class="skeleton" style="width:60%;height:32px;margin-top:40px"></div></div><div class="stat-card"><div class="skeleton" style="width:60%;height:32px;margin-top:40px"></div></div><div class="stat-card"><div class="skeleton" style="width:60%;height:32px;margin-top:40px"></div></div></div>`;
    try {
      const stats = await API.getStats();
      this.el.innerHTML = `
        <div class="page-header"><div><h1 class="page-title">Painel</h1><p class="page-subtitle">A sua visão geral de impressão 3D</p></div></div>
        ${UI.statsCards(stats)}
        <div class="dashboard-panels">
          <div class="glass-panel"><div class="panel-header"><div class="panel-title"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Modelos Recentes</div></div><div class="panel-body">${UI.recentModels(stats.recentModels)}</div></div>
          <div class="glass-panel"><div class="panel-header"><div class="panel-title"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>Impressões Recentes</div></div><div class="panel-body">${UI.recentPrints(stats.recentPrints)}</div></div>
          <div class="glass-panel"><div class="panel-header"><div class="panel-title"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>Utilização de Material</div></div><div class="panel-body">${UI.materialChart(stats.materialUsage)}</div></div>
        </div>`;
    } catch (e) {
      this.el.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent-yellow)"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="empty-state-text">Falha ao carregar o painel</div></div>';
    }
  },

  // ─── Lista de Modelos ──────────────────────────────────────────────────────
  async renderModels(params = {}) {
    // verificar se devemos mostrar a vista de pastas
    if (this.libraryViewMode === 'folder') {
      return this.renderBrowse(params.path || '');
    }

    const activeFormat = params.format || this.currentFormatFilter || 'all';
    this.currentFormatFilter = activeFormat;
    const toolbar = UI.toolbar(this.cache.categories, this.cache.tags, this.cache.users, activeFormat);
    this.el.innerHTML = `
      <div class="page-header">
        <div><h1 class="page-title">Modelos</h1><p class="page-subtitle">Faça a gestão da sua biblioteca de modelos 3D</p></div>
      </div>
      ${toolbar}
      <div id="models-grid"><div class="model-grid">${'<div class="model-card"><div class="model-card-thumb"><div class="skeleton" style="width:100%;height:100%"></div></div><div class="model-card-body"><div class="skeleton" style="width:70%;height:18px;margin-bottom:8px"></div><div class="skeleton" style="width:40%;height:14px"></div></div></div>'.repeat(6)}</div></div>`;

    // Restaurar valores dos filtros
    if (params.search) document.getElementById('search-input').value = params.search;
    if (params.category) document.getElementById('filter-category').value = params.category;
    if (params.tag) document.getElementById('filter-tag').value = params.tag;
    if (params.user) document.getElementById('filter-user').value = params.user;
    if (params.printed) document.getElementById('filter-printed').value = params.printed;
    if (params.sort) document.getElementById('filter-sort').value = params.sort;
    if (params.limit) {
      const limitSelect = document.getElementById('filter-limit');
      if (limitSelect) limitSelect.value = params.limit;
    }

    // Ocultar a análise se não for administrador
    if (!this.currentUser || this.currentUser.role !== 'admin') {
      const scanBtn = document.getElementById('scan-btn');
      if (scanBtn) scanBtn.style.display = 'none';
    }

    await this.fetchAndRenderModels(params);
  },

  // ─── Navegador de Pastas ─────────────────────────────────────────────────
  async renderBrowse(browsePath = '') {
    this.currentBrowsePath = browsePath;
    const toolbar = UI.toolbar(this.cache.categories, this.cache.tags, this.cache.users);
    this.el.innerHTML = `
      <div class="page-header">
        <div><h1 class="page-title">Explorar Biblioteca</h1><p class="page-subtitle">Explore os seus ficheiros em disco</p></div>
      </div>
      ${toolbar}
      <div id="browse-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; min-height:36px;"></div>
      <div id="browse-wrapper" style="display:flex;gap:20px;align-items:flex-start">
        <div id="browse-tree" style="min-width:240px"><div class="skeleton" style="width:240px;height:300px;border-radius:8px"></div></div>
        <div id="browse-content" style="flex:1;min-width:0"><div class="model-grid">${'<div class="model-card"><div class="model-card-thumb"><div class="skeleton" style="width:100%;height:100%"></div></div><div class="model-card-body"><div class="skeleton" style="width:70%;height:18px;margin-bottom:8px"></div><div class="skeleton" style="width:40%;height:14px"></div></div></div>'.repeat(6)}</div></div>
      </div>`;

    try {
      // obter a árvore e a pasta atual em paralelo
      const [tree, data] = await Promise.all([
        API.getFolderTree(),
        API.browseLibrary(browsePath)
      ]);

      // desenhar a árvore lateral
      const treeEl = document.getElementById('browse-tree');
      if (treeEl) treeEl.innerHTML = UI.folderTree(tree, browsePath);

      // desenhar o cabeçalho com breadcrumbs, botão de Nova Pasta e pesquisa
      const headerEl = document.getElementById('browse-header');
      if (headerEl) {
        const fileCount = data.files.filter(f => f.type !== 'image').length;
        headerEl.innerHTML = `
          <div style="flex:1;display:flex;align-items:center;gap:12px">
            ${UI.breadcrumbs(data.currentPath)}
            ${this.currentUser ? `<button class="btn btn-secondary btn-sm" onclick="App.handleCreateFolder('${data.currentPath}')">+ Nova Pasta</button>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <span style="font-size:0.85rem;color:var(--text-muted);white-space:nowrap" id="browse-counter">A mostrar ${data.folders.length} Pastas / ${fileCount} Ficheiros</span>
            <div style="width:250px">
              <input type="text" id="browse-search" placeholder="Filtrar esta pasta..." class="form-input" onkeyup="App.handleBrowseSearch(event)" style="padding:6px 12px; font-size:.9rem;">
            </div>
          </div>
        `;
      }

      // desenhar o conteúdo da pasta
      const container = document.getElementById('browse-content');
      if (!container) return;

      const sortMode = document.getElementById('filter-sort')?.value || 'name';
      if (sortMode === 'name') {
        data.files.sort((a,b) => a.name.localeCompare(b.name));
      } else if (sortMode === 'updated' || sortMode === 'created') {
        data.files.sort((a,b) => (b.mtime || 0) - (a.mtime || 0));
      }

      const foldersHtml = data.folders.map(f => UI.folderCard(f)).join('');
      const filesHtml = data.files.filter(f => f.type !== 'image').map(f => UI.browseFileCard(f)).join('');

      if (!data.folders.length && !data.files.length) {
        container.innerHTML = `
          <div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div><div class="empty-state-text">Esta pasta está vazia</div><div class="empty-state-sub">Não foram encontrados ficheiros 3D ou subpastas aqui</div></div>`;
        return;
      }

      container.innerHTML = `
        <div class="model-grid">
          ${foldersHtml}
          ${filesHtml}
        </div>`;

      this.renderBulkBrowseBar();

      // acionar a geração de miniaturas STL
      if (typeof Viewer !== 'undefined' && Viewer.generateThumbnails) {
        setTimeout(() => Viewer.generateThumbnails(), 50);
      }
    } catch(e) {
      console.error(e);
      const container = document.getElementById('browse-content');
      if (container) container.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent-yellow)"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="empty-state-text">Falha ao carregar pasta</div></div>';
    }
  },

  browseTo(folderPath) {
    this.navigate(`/models?path=${encodeURIComponent(folderPath)}`);
  },

  handleBrowseSearch(e) {
    const q = e.target.value;
    clearTimeout(this.browseSearchTimeout);
    this.browseSearchTimeout = setTimeout(async () => {
      const container = document.getElementById('browse-content');
      if (!container) return;
      
      container.innerHTML = '<div class="model-grid">' + '<div class="model-card"><div class="model-card-thumb"><div class="skeleton" style="width:100%;height:100%"></div></div><div class="model-card-body"><div class="skeleton" style="width:70%;height:18px;margin-bottom:8px"></div><div class="skeleton" style="width:40%;height:14px"></div></div></div>'.repeat(6) + '</div>';
      
      try {
        const data = q ? await API.searchLibrary(q) : await API.browseLibrary(new URLSearchParams(location.hash.split('?')[1]).get('path') || '');
        
        // Filtrar com base nas definições da barra de ferramentas
        const sortMode = document.getElementById('filter-sort')?.value || 'name';
        if (sortMode === 'name') {
          data.files.sort((a,b) => a.name.localeCompare(b.name));
        } else if (sortMode === 'updated' || sortMode === 'created') {
          data.files.sort((a,b) => (b.mtime || 0) - (a.mtime || 0));
        }

        const foldersHtml = data.folders.map(f => UI.folderCard(f)).join('');
        const filesHtml = data.files.filter(f => f.type !== 'image').map(f => UI.browseFileCard(f)).join('');
        
        if (!data.folders.length && !data.files.length) {
          container.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div><div class="empty-state-text">Não foram encontrados resultados</div></div>`;
          return;
        }
        
        container.innerHTML = `<div class="model-grid">${foldersHtml}${filesHtml}</div>`;
        this.renderBulkBrowseBar();
        if (typeof Viewer !== 'undefined' && Viewer.generateThumbnails) setTimeout(() => Viewer.generateThumbnails(), 50);
      } catch(err) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent-yellow)"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="empty-state-text">Pesquisa falhada</div></div>';
      }
    }, 400);
  },

  handleDragStart(e, itemPath) {
    e.dataTransfer.setData('text/plain', itemPath);
    e.dataTransfer.effectAllowed = 'move';

    const dragIcon = document.createElement('div');
    dragIcon.style.position = 'absolute';
    dragIcon.style.top = '-1000px';
    dragIcon.style.background = 'var(--accent-cyan)';
    dragIcon.style.color = '#fff';
    dragIcon.style.padding = '6px 12px';
    dragIcon.style.borderRadius = '20px';
    dragIcon.style.fontWeight = 'bold';
    dragIcon.style.fontSize = '12px';
    dragIcon.style.boxShadow = '0 4px 8px rgba(0,0,0,0.5)';
    dragIcon.style.pointerEvents = 'none';
    dragIcon.innerText = itemPath.split('/').pop();
    
    document.body.appendChild(dragIcon);
    e.dataTransfer.setDragImage(dragIcon, 10, 10);
    setTimeout(() => dragIcon.remove(), 100);
  },

  async handleDrop(e, targetFolderPath) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('drag-over');
    
    const sourceItemPath = e.dataTransfer.getData('text/plain');
    if (!sourceItemPath || sourceItemPath === targetFolderPath) return;
    
    try {
      await API.moveItem(sourceItemPath, targetFolderPath);
      this.toast('Movido com sucesso');
      this.renderBrowse(this.currentBrowsePath);
    } catch(err) {
      this.toast(err.message, 'error');
    }
  },

  async handleCreateFolder(parentPath) {
    const name = prompt('Introduza o nome da nova pasta:');
    if (!name) return;
    try {
      await API.createFolder(parentPath, name);
      this.toast('Pasta criada');
      this.renderBrowse(this.currentBrowsePath);
    } catch(err) {
      this.toast(err.message, 'error');
    }
  },

  setFormatFilter(format, btn) {
    this.currentFormatFilter = format || 'all';
    document.querySelectorAll('.format-pill').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    else {
      const el = document.getElementById(`pill-format-${format}`);
      if (el) el.classList.add('active');
    }
    this.handleFilter();
  },

  async fetchAndRenderModels(params = {}) {
    try {
      if (params.format) this.currentFormatFilter = params.format;
      const queryParams = { ...params };
      if (this.currentFormatFilter && this.currentFormatFilter !== 'all') {
        queryParams.format = this.currentFormatFilter;
      }
      
      const response = await API.getModels(queryParams);
      
      // Tratar o novo formato de resposta paginada ou recorrer a um array
      const models = Array.isArray(response) ? response : (response.models || []);
      const totalPages = response.totalPages || 1;
      const currentPage = response.currentPage || 1;

      // Atualizar o contador dinâmico da biblioteca na barra de ferramentas
      const statsCounter = document.getElementById('library-summary-stats');
      if (statsCounter) {
        const sizeStr = response.totalStorageBytes ? ` • ${UI.formatSize(response.totalStorageBytes)}` : '';
        statsCounter.textContent = `${response.totalItems || 0} modelos${sizeStr}`;
      }

      const grid = document.getElementById('models-grid');
      if (!grid) return;
      if (!models.length) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div><div class="empty-state-text">Nenhum modelo encontrado</div><div class="empty-state-sub">Tente alterar os filtros ou criar um novo modelo</div></div>';
        return;
      }
      
      const viewMode = localStorage.getItem('gv_view_mode') || 'grid';
      grid.innerHTML = `
        <div class="model-grid ${viewMode === 'list' ? 'models-list-view' : ''}">${models.map(m => UI.modelCard(m)).join('')}</div>
        ${UI.pagination(totalPages, currentPage)}
      `;
      this.setViewMode(viewMode); // realçar o botão correto
      this.renderBulkBar();
      if (typeof Viewer !== 'undefined' && Viewer.generateThumbnails) {
        setTimeout(() => Viewer.generateThumbnails(), 50);
      }
    } catch (e) {
      console.error(e);
      document.getElementById('models-grid').innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent-yellow)"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="empty-state-text">Falha ao carregar modelos</div></div>';
    }
  },

  setViewMode(mode) {
    localStorage.setItem('gv_view_mode', mode);
    const viewGridBtn = document.getElementById('view-mode-grid');
    const viewListBtn = document.getElementById('view-mode-list');
    if (viewGridBtn) viewGridBtn.style.color = mode === 'grid' ? 'var(--accent-cyan)' : 'inherit';
    if (viewListBtn) viewListBtn.style.color = mode === 'list' ? 'var(--accent-cyan)' : 'inherit';
    
    const gridContainer = document.querySelector('#models-grid .model-grid');
    if (gridContainer) {
      if (mode === 'list') {
        gridContainer.classList.add('models-list-view');
      } else {
        gridContainer.classList.remove('models-list-view');
      }
    }
  },

  renderBulkBar() {
    let bar = document.getElementById('bulk-action-bar-container');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bulk-action-bar-container';
      document.body.appendChild(bar);
    }
    bar.innerHTML = UI.bulkActionBar(this.selectedModelIds.length);
  },

  toggleModelSelection(e, id) {
    if (e) e.stopPropagation();
    if (e?.shiftKey && this.lastSelectedModelId !== null) {
      this.selectModelRange(this.lastSelectedModelId, id);
      this.lastSelectedModelId = id;
      return;
    }

    const idx = this.selectedModelIds.indexOf(id);
    if (idx > -1) this.selectedModelIds.splice(idx, 1);
    else this.selectedModelIds.push(id);
    this.lastSelectedModelId = id;
    
    // Atualizar a interface sem redesenhar tudo
    const card = document.querySelector(`.model-card[data-model-id="${id}"]`);
    if (card) card.classList.toggle('selected');
    this.renderBulkBar();
  },

  handleModelCardClick(e, id) {
    if (e?.shiftKey || e?.ctrlKey || e?.metaKey) {
      this.toggleModelSelection(e, id);
      return;
    }

    if (this.selectedModelIds.length > 0) {
      this.toggleModelSelection(e, id);
    } else {
      this.navigate(`/models/${id}`);
    }
  },

  selectModelRange(startId, endId) {
    const cards = Array.from(document.querySelectorAll('.model-card[data-model-id]'));
    const startIndex = cards.findIndex(c => Number(c.dataset.modelId) === startId);
    const endIndex = cards.findIndex(c => Number(c.dataset.modelId) === endId);
    if (startIndex === -1 || endIndex === -1) {
      this.toggleModelSelection(null, endId);
      return;
    }

    const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    const ids = cards.slice(from, to + 1).map(c => Number(c.dataset.modelId));
    this.selectedModelIds = Array.from(new Set([...this.selectedModelIds, ...ids]));
    cards.forEach(c => c.classList.toggle('selected', this.selectedModelIds.includes(Number(c.dataset.modelId))));
    this.renderBulkBar();
  },

  clearSelection() {
    this.selectedModelIds = [];
    this.lastSelectedModelId = null;
    document.querySelectorAll('.model-card.selected').forEach(c => c.classList.remove('selected'));
    this.renderBulkBar();
  },

  selectAll() {
    const cards = document.querySelectorAll('.model-card');
    this.selectedModelIds = Array.from(cards).map(c => Number(c.dataset.modelId));
    this.lastSelectedModelId = this.selectedModelIds.at(-1) || null;
    cards.forEach(c => c.classList.add('selected'));
    this.renderBulkBar();
  },

  openBulkDelete() { this.openModal('Eliminar em Massa', UI.bulkDeleteForm(this.selectedModelIds.length)); },
  async handleBulkDelete(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await API.bulkDeleteModels(this.selectedModelIds, fd.get('delete_disk') === 'on');
      this.toast(`${this.selectedModelIds.length} modelos eliminados`);
      this.clearSelection();
      this.closeModal();
      this.route();
    } catch(e) { this.toast(e.message, 'error'); }
  },
  openBulkTag() { this.openModal('Etiquetar Modelos em Massa', UI.bulkTagForm(this.cache.tags)); },
  async handleBulkTagSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const selectedTags = fd.getAll('tags');
    const inlineTagInput = document.getElementById('new-bulk-tag-input');
    const tagMode = fd.get('tag_mode') || 'add';
    
    let tagsToApply = [...selectedTags];
    if (inlineTagInput && inlineTagInput.value.trim()) {
      const inlineTags = inlineTagInput.value.split(',').map(t => t.trim()).filter(Boolean);
      tagsToApply = tagsToApply.concat(inlineTags);
    }
    
    if (tagsToApply.length === 0) {
      this.toast('Selecione ou introduza pelo menos uma etiqueta', 'error');
      return;
    }
    
    try {
      if (tagMode === 'replace') {
        await API.bulkUpdateModels(this.selectedModelIds, { tags: tagsToApply });
      } else {
        await API.bulkUpdateModels(this.selectedModelIds, { add_tags: tagsToApply });
      }
      this.toast(`Etiquetas atualizadas em ${this.selectedModelIds.length} modelos`);
      this.clearSelection();
      this.closeModal();
      this.cache.tags = await API.getTags().catch(() => this.cache.tags);
      this.route();
    } catch(e) { this.toast(e.message, 'error'); }
  },

  openBulkMove() { this.openModal('Mover para Categoria', UI.bulkMoveForm(this.cache.categories)); },
  async handleBulkMove(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const catId = fd.get('category_id') || null;
    try {
      await API.bulkUpdateModels(this.selectedModelIds, { category_id: catId });
      this.toast(`Categoria atualizada em ${this.selectedModelIds.length} modelos`);
      this.clearSelection();
      this.closeModal();
      this.cache.categories = await API.getCategories().catch(() => this.cache.categories);
      this.route();
    } catch(e) { this.toast(e.message, 'error'); }
  },

  async openBulkAddToCollection() {
    const projects = await API.getProjects();
    this.openModal('Adicionar à Coleção', UI.bulkCollectionForm(projects));
  },
  async handleBulkAddToCollectionSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await API.bulkAddModelsToProject(fd.get('project_id'), this.selectedModelIds);
      this.toast(`${this.selectedModelIds.length} modelos adicionados à coleção`);
      this.clearSelection();
      this.closeModal();
    } catch(e) { this.toast(e.message, 'error'); }
  },

  renderBulkBrowseBar() {
    let bar = document.getElementById('bulk-browse-action-bar-container');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'bulk-browse-action-bar-container';
      document.body.appendChild(bar);
    }
    
    // Verificar se todos os itens apresentados estão selecionados
    const allCards = document.querySelectorAll('#browse-content .model-card');
    const allPaths = Array.from(allCards).map(c => c.dataset.path).filter(Boolean);
    const isAllSelected = allPaths.length > 0 && allPaths.every(p => this.selectedBrowsePaths.includes(p));

    bar.innerHTML = UI.bulkBrowseActionBar(this.selectedBrowsePaths.length, isAllSelected);
  },

  toggleBrowseSelection(path) {
    const idx = this.selectedBrowsePaths.indexOf(path);
    if (idx > -1) this.selectedBrowsePaths.splice(idx, 1);
    else this.selectedBrowsePaths.push(path);
    
    // Atualizar a interface sem redesenhar tudo
    const escapedPath = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const card = document.querySelector(`.model-card[data-path="${escapedPath}"]`);
    if (card) card.classList.toggle('selected');
    this.renderBulkBrowseBar();
  },

  clearBrowseSelection() {
    this.selectedBrowsePaths = [];
    document.querySelectorAll('#browse-content .model-card.selected').forEach(c => c.classList.remove('selected'));
    this.renderBulkBrowseBar();
  },

  toggleBrowseSelectAll() {
    const allCards = document.querySelectorAll('#browse-content .model-card');
    const allPaths = Array.from(allCards).map(c => c.dataset.path).filter(Boolean);
    
    const isAllSelected = allPaths.length > 0 && allPaths.every(p => this.selectedBrowsePaths.includes(p));
    
    if (isAllSelected) {
      // Desselecionar apenas os atualmente apresentados
      this.selectedBrowsePaths = this.selectedBrowsePaths.filter(p => !allPaths.includes(p));
      allCards.forEach(c => c.classList.remove('selected'));
    } else {
      // Selecionar todos os apresentados
      allPaths.forEach(p => {
        if (!this.selectedBrowsePaths.includes(p)) this.selectedBrowsePaths.push(p);
      });
      allCards.forEach(c => c.classList.add('selected'));
    }
    this.renderBulkBrowseBar();
  },

  openBulkBrowseMove() {
    this.openModal('Mover Itens', UI.bulkBrowseMoveForm());
  },
  
  async handleBulkBrowseMoveSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await API.bulkMoveItems(this.selectedBrowsePaths, fd.get('target_path'));
      this.toast(`${this.selectedBrowsePaths.length} itens movidos`);
      this.clearBrowseSelection();
      this.closeModal();
      this.renderBrowse(this.currentBrowsePath);
    } catch(err) { this.toast(err.message, 'error'); }
  },

  openBulkBrowseDelete() {
    this.openModal('Eliminar em Massa', UI.bulkBrowseDeleteForm(this.selectedBrowsePaths.length));
  },

  async handleBulkBrowseDeleteSubmit(e) {
    e.preventDefault();
    try {
      await API.bulkDeleteItems(this.selectedBrowsePaths);
      this.toast(`${this.selectedBrowsePaths.length} itens eliminados`);
      this.clearBrowseSelection();
      this.closeModal();
      this.renderBrowse(this.currentBrowsePath);
    } catch(err) { this.toast(err.message, 'error'); }
  },

  openBulkBrowseTag() {
    this.openModal('Etiquetar Itens em Massa', UI.bulkBrowseTagForm(this.cache.tags));
  },

  async handleBulkBrowseTagSubmit(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const selectedTags = fd.getAll('tags');
    const inlineTagInput = document.getElementById('new-bulk-tag-input');
    
    let tagsToApply = [...selectedTags];
    if (inlineTagInput && inlineTagInput.value.trim()) {
      const inlineTags = inlineTagInput.value.split(',').map(t => t.trim()).filter(Boolean);
      tagsToApply = tagsToApply.concat(inlineTags);
    }
    
    if (tagsToApply.length === 0) {
      this.toast('Selecione ou introduza pelo menos uma etiqueta', 'error');
      return;
    }
    
    try {
      await API.bulkTagItems(this.selectedBrowsePaths, tagsToApply);
      this.toast(`${this.selectedBrowsePaths.length} itens etiquetados`);
      this.clearBrowseSelection();
      this.closeModal();
      // A aplicação de etiquetas pode não se refletir de imediato na vista de pastas sem nova análise ou pedido ao servidor, mas voltar a desenhar é seguro
      this.renderBrowse(this.currentBrowsePath);
    } catch(err) { this.toast(err.message, 'error'); }
  },

  handleSearch(val) {
    clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => this.handleFilter(), 300);
  },

  handleFilter() {
    const params = new URLSearchParams();
    const search = document.getElementById('search-input')?.value;
    const category = document.getElementById('filter-category')?.value;
    const tag = document.getElementById('filter-tag')?.value;
    const user = document.getElementById('filter-user')?.value;
    const printed = document.getElementById('filter-printed')?.value;
    const sort = document.getElementById('filter-sort')?.value;
    const limit = document.getElementById('filter-limit')?.value;

    if (search) params.set('search', search);
    if (category) params.set('category', category);
    if (tag) params.set('tag', tag);
    if (this.currentFormatFilter && this.currentFormatFilter !== 'all') params.set('format', this.currentFormatFilter);
    if (user) params.set('user', user);
    if (printed) params.set('printed', printed);
    if (sort && sort !== 'updated') params.set('sort', sort);
    if (limit && limit !== '24') params.set('limit', limit);
    params.set('page', '1');

    if (this.libraryViewMode === 'folder') {
      this.renderBrowse(this.currentBrowsePath);
    } else {
      window.location.hash = `/models?${params.toString()}`;
    }
  },

  goToPage(pageNumber) {
    const params = new URLSearchParams();
    const search = document.getElementById('search-input')?.value;
    const category = document.getElementById('filter-category')?.value;
    const tag = document.getElementById('filter-tag')?.value;
    const user = document.getElementById('filter-user')?.value;
    const printed = document.getElementById('filter-printed')?.value;
    const sort = document.getElementById('filter-sort')?.value;
    const limit = document.getElementById('filter-limit')?.value;

    if (search) params.set('search', search);
    if (category) params.set('category', category);
    if (tag) params.set('tag', tag);
    if (this.currentFormatFilter && this.currentFormatFilter !== 'all') params.set('format', this.currentFormatFilter);
    if (user) params.set('user', user);
    if (printed) params.set('printed', printed);
    if (sort && sort !== 'updated') params.set('sort', sort);
    if (limit && limit !== '24') params.set('limit', limit);
    params.set('page', pageNumber);

    window.location.hash = `/models?${params.toString()}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  // ── Autenticação ──
  showLogin() { 
    const allowReg = this.publicConfig && this.publicConfig.open_registration;
    this.openModal('Iniciar Sessão', UI.loginForm(allowReg)); 
  },
  showRegister(token = '') { this.openModal('Registar', UI.registerForm(token)); },
  showForgotPassword() { this.openModal('Repor Palavra-passe', UI.forgotPasswordForm()); },
  showResetPassword(token) { if (token) this.openModal('Escolher Nova Palavra-passe', UI.resetPasswordForm(token)); },
  
  async handleLogin(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await API.login(fd.get('username'), fd.get('password'));
      if (!res || !res.csrfToken) {
        this.toast('Nome de utilizador ou palavra-passe inválidos', 'error');
        return;
      }
      if (res.error) throw new Error(res.error);
      localStorage.setItem('pv_csrf_token', res.csrfToken);
      localStorage.setItem('pv_user', JSON.stringify(res.user));
      this.currentUser = res.user;
      this.toast('Bem-vindo de volta, ' + res.user.username);
      this.closeModal();
      this.updateUserNav();
      await this.loadCache();
      this.route();
    } catch(e) { this.toast(e.message, 'error'); }
  },
  
  async handleRegister(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await API.register(fd.get('username'), fd.get('email'), fd.get('password'), fd.get('token'));
      this.toast('Registo efetuado com sucesso! Inicie sessão.');
      this.showLogin();
    } catch(e) { this.toast(e.message, 'error'); }
  },

  async handleInviteUser(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    if (btn) { btn.disabled = true; btn.textContent = 'A enviar...'; }
    const fd = new FormData(e.target);
    try {
      await API.inviteUser(fd.get('email'));
      this.toast('Convite enviado com sucesso', 'success');
      e.target.reset();
    } catch(err) {
      this.toast(err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar Convite'; }
    }
  },

  async changeUserRole(userId, selectElem) {
    try {
      const newRole = selectElem.value;
      await API.updateUserRole(userId, newRole);
      this.toast('Função do utilizador atualizada com sucesso', 'success');
      // acionar a atualização do separador de definições
      const usersBtn = document.querySelector('.tab-btn[data-tab="users"]');
      if (usersBtn) usersBtn.click();
    } catch (err) {
      this.toast(err.message, 'error');
      // Reverter seleção em caso de erro
      const usersBtn = document.querySelector('.tab-btn[data-tab="users"]');
      if (usersBtn) usersBtn.click();
    }
  },

  async deleteUser(userId) {
    if (!confirm('Tem a certeza de que quer eliminar este utilizador? Esta ação não pode ser desfeita.')) return;
    try {
      await API.deleteUser(userId);
      this.toast('Utilizador eliminado com sucesso', 'success');
      // acionar a atualização do separador de definições
      const usersBtn = document.querySelector('.tab-btn[data-tab="users"]');
      if (usersBtn) usersBtn.click();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },


  async handleForgotPassword(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await API.forgotPassword(fd.get('email'));
      this.toast(res.message);
      this.closeModal();
    } catch(e) { this.toast(e.message, 'error'); }
  },

  async handleResetPassword(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get('password') !== fd.get('confirm')) return this.toast('As palavras-passe não coincidem', 'error');
    try {
      const res = await API.resetPassword(fd.get('token'), fd.get('password'));
      this.toast(res.message);
      this.closeModal();
      window.location.hash = '#/';
      this.showLogin();
    } catch(e) { this.toast(e.message, 'error'); }
  },
  
  async handleUpdateProfile(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = { username: fd.get('username'), email: fd.get('email') };
    if (fd.get('password')) data.password = fd.get('password');
    if (fd.has('preferred_slicer')) data.preferred_slicer = fd.get('preferred_slicer');
    try {
      await API.updateProfile(data);
      this.toast('Perfil atualizado com sucesso');
      // Atualizar informação do utilizador
      const user = await API.getMe();
      this.currentUser = user;
      localStorage.setItem('pv_user', JSON.stringify(user));
      this.updateUserNav();
    } catch(e) { this.toast(e.message, 'error'); }
  },

  async generateApiKey() {
    try {
      const res = await API.generateApiKey();
      if (res.api_key) {
        const resultDiv = document.getElementById('api-key-result');
        if (resultDiv) {
          resultDiv.textContent = res.api_key;
          resultDiv.style.display = 'block';
          this.toast('Chave API gerada com sucesso', 'success');
        }
      }
    } catch(e) { this.toast(e.message || 'Falha ao gerar chave API', 'error'); }
  },

  async handleSaveSMTP(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd.entries());
    try {
      await API.saveSMTPSettings(data);
      this.toast('Definições SMTP guardadas');
    } catch(e) { this.toast(e.message, 'error'); }
  },
  
  async handleSaveSystemSettings(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd.entries());
    data.open_registration = fd.has('open_registration') ? 'true' : 'false';
    data.require_login_to_view = fd.has('require_login_to_view') ? 'true' : 'false';
    try {
      await API.saveSystemSettings(data);
      await this.loadViewMode(); // atualizar o modo de vista em cache
      this.toast('Definições do sistema guardadas');
    } catch(e) { this.toast(e.message, 'error'); }
  },

    async handleAddPrinter(e) {
      e.preventDefault();
      const fd = new FormData(e.target);
      const newPrinter = { 
        id: Date.now().toString(), 
        name: fd.get('name'), 
        url: fd.get('url').replace(/\/$/, ''),
        api_key: fd.get('api_key') || ''
      };
    
    try {
      const config = await API.getSystemSettings();
      let printers = [];
      try { if (config.printers) printers = JSON.parse(config.printers); } catch(e){}
      printers.push(newPrinter);
      await API.saveSystemSettings({ printers: JSON.stringify(printers) });
      this.toast('Impressora adicionada');
      this.renderSettings();
    } catch(err) { this.toast(err.message, 'error'); }
  },

  async deletePrinter(id) {
    if (!confirm('Remover esta impressora?')) return;
    try {
      const config = await API.getSystemSettings();
      let printers = [];
      try { if (config.printers) printers = JSON.parse(config.printers); } catch(e){}
      printers = printers.filter(p => p.id !== id);
      await API.saveSystemSettings({ printers: JSON.stringify(printers) });
      this.toast('Impressora removida');
      this.renderSettings();
    } catch(err) { this.toast(err.message, 'error'); }
  },
  
  async testSMTP(e) {
    if (e) e.preventDefault();
    const btn = e?.target;
    
    // Primeiro, guardar as definições atuais para testar o que está no ecrã
    const form = btn.closest('form');
    if (form) {
      try {
        const fd = new FormData(form);
        const data = Object.fromEntries(fd.entries());
        await API.saveSMTPSettings(data);
      } catch(e) { 
        return this.toast('Falha ao guardar definições antes do teste: ' + e.message, 'error'); 
      }
    }
    
    this.openModal('Testar Ligação SMTP', UI.smtpTestModal(this.currentUser?.email || ""));
  },

  async handleSendTestEmail(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = fd.get('test_email');
    const btn = document.getElementById('send-test-btn');

    if (btn) { btn.disabled = true; btn.textContent = 'A enviar...'; }
    try {
      await API.testSMTP({ email });
      this.toast('E-mail de teste enviado com sucesso! Verifique a sua caixa de entrada.', 'success');
      this.closeModal();
    } catch(e) { 
      this.toast(e.message, 'error'); 
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar Teste'; }
    }
  },
  
  async handleLogout() {
    try { await API.logout(); } catch(e) {}
    localStorage.removeItem('pv_csrf_token');
    localStorage.removeItem('pv_user');
    this.currentUser = null;
    this.toast('Sessão terminada');
    this.updateUserNav();
    this.route();
  },
  
  updateUserNav() {
    const avatar = document.getElementById('sidebar-user-avatar');
    const username = document.getElementById('sidebar-username');
    const role = document.getElementById('sidebar-user-role');
    const wrapper = document.getElementById('nav-login-wrapper');
    const settingsLink = document.getElementById('nav-settings');
    
    if (this.currentUser) {
      if (avatar) avatar.textContent = (this.currentUser.username || 'U').charAt(0).toUpperCase();
      if (username) username.textContent = this.currentUser.username;
      if (role) role.textContent = this.currentUser.role ? `${this.currentUser.role.charAt(0).toUpperCase()}${this.currentUser.role.slice(1)}` : 'Membro';
      if (settingsLink) {
        settingsLink.style.display = (this.currentUser.role === 'admin') ? 'flex' : 'none';
      }
      if (wrapper) {
        wrapper.innerHTML = `
          <button class="btn-icon" onclick="App.handleLogout()" title="Terminar Sessão">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>`;
      }
    } else {
      if (avatar) avatar.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
      if (username) username.textContent = 'Utilizador Convidado';
      if (role) role.textContent = 'Clique para iniciar sessão';
      if (settingsLink) settingsLink.style.display = 'none';
      if (wrapper) {
        wrapper.innerHTML = `
          <button class="btn-icon" onclick="App.showLogin()" title="Iniciar Sessão">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          </button>`;
      }
    }
  },

  handleUserProfileClick() {
    if (this.currentUser) {
      this.navigate('/profile');
    } else {
      this.showLogin();
    }
  },

  async renderProfile() {
    if (!this.currentUser) return this.navigate('/');
    
    this.el.innerHTML = `
      <div class="page-header">
        <div><h1 class="page-title">O Meu Perfil</h1><p class="page-subtitle">Faça a gestão das definições e preferências da sua conta</p></div>
      </div>
      <div class="settings-tabs" style="display:flex;gap:8px;margin-bottom:24px;border-bottom:1px solid var(--border);padding-bottom:1px">
        <button class="tab-btn active" data-tab="account" style="background:none;border:none;color:var(--text-secondary);padding:10px 20px;cursor:pointer;font-weight:600;border-bottom:2px solid transparent;transition:all .2s">Detalhes da Conta</button>
        <button class="tab-btn" data-tab="appearance" style="background:none;border:none;color:var(--text-secondary);padding:10px 20px;cursor:pointer;font-weight:600;border-bottom:2px solid transparent;transition:all .2s">Aparência Local</button>
        <button class="tab-btn" data-tab="api" style="background:none;border:none;color:var(--text-secondary);padding:10px 20px;cursor:pointer;font-weight:600;border-bottom:2px solid transparent;transition:all .2s">API e Integrações</button>
      </div>
      <div id="profile-content"></div>`;

    const content = this.el.querySelector('#profile-content');
    const tabs = this.el.querySelectorAll('.tab-btn');
    const user = this.currentUser;

    const switchTab = (tab) => {
      tabs.forEach(t => {
        const active = t.dataset.tab === tab;
        t.style.color = active ? 'var(--accent-cyan)' : 'var(--text-secondary)';
        t.style.borderBottomColor = active ? 'var(--accent-cyan)' : 'transparent';
      });

      if (tab === 'account') {
        content.innerHTML = `
          <div class="glass-panel">
            <div class="panel-header"><div class="panel-title">Detalhes da Conta</div></div>
            <div class="panel-body">
              <form onsubmit="App.handleUpdateProfile(event)" class="form-grid">
                <div class="form-group">
                  <label class="form-label">Nome de Utilizador</label>
                  <input type="text" name="username" value="${user.username}" required class="form-input">
                </div>
                <div class="form-group">
                  <label class="form-label">Endereço de E-mail</label>
                  <input type="email" name="email" value="${user.email || ''}" required class="form-input">
                </div>
                <div class="form-group">
                  <label class="form-label">Nova Palavra-passe</label>
                  <input type="password" name="password" placeholder="Deixe em branco para manter a atual" class="form-input">
                  <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 6px;">Deve ter pelo menos 8 caracteres e conter letras e números.</p>
                </div>
                <div class="form-group">
                  <label class="form-label">Slicer Preferido</label>
                  <select name="preferred_slicer" class="form-select">
                    <option value="" ${!user.preferred_slicer ? 'selected' : ''}>Nenhum (Perguntar sempre)</option>
                    <option value="orcaslicer" ${user.preferred_slicer === 'orcaslicer' ? 'selected' : ''}>OrcaSlicer</option>
                    <option value="elegooslicer" ${user.preferred_slicer === 'elegooslicer' ? 'selected' : ''}>Elegoo Slicer</option>
                    <option value="cura" ${user.preferred_slicer === 'cura' ? 'selected' : ''}>Ultimaker Cura</option>
                    <option value="bambustudio" ${user.preferred_slicer === 'bambustudio' ? 'selected' : ''}>Bambu Studio</option>
                  </select>
                </div>
                <div style="margin-top:24px; padding-top:20px; border-top:1px solid var(--border); display:flex; justify-content:flex-end;">
                  <button type="submit" class="btn btn-primary">Guardar Alterações</button>
                </div>
              </form>
            </div>
          </div>
        `;
      } else if (tab === 'appearance') {
        content.innerHTML = `
          <div class="glass-panel">
            <div class="panel-header"><div class="panel-title">Aparência Local</div></div>
            <div class="panel-body">
              <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 20px;">Estas definições de interface são guardadas apenas no seu navegador atual.</p>
              <div class="form-grid">
                <div class="form-group">
                  <label class="form-label">Tema da Aplicação</label>
                  <select id="theme-selector" class="form-select" onchange="App.previewTheme()">
                    <option value="glass" ${localStorage.getItem('gv_theme') === 'glass' || !localStorage.getItem('gv_theme') ? 'selected' : ''}>Vidro (Predefinido)</option>
                    <option value="industrial" ${localStorage.getItem('gv_theme') === 'industrial' ? 'selected' : ''}>Industrial</option>
                  </select>
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label class="form-label">Cor de Destaque</label>
                  <p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:12px">Escolha a sua cor de destaque preferida</p>
                  <div style="display:flex; gap:12px; margin-top:6px; flex-wrap:wrap;">
                    <button type="button" class="accent-color-btn" style="background:#3b82f6; outline: ${(localStorage.getItem('gv_accent') === 'blue' || localStorage.getItem('gv_accent') === 'cyan' || !localStorage.getItem('gv_accent')) ? '2px solid #ffffff' : 'none'}" onclick="App.setAccent('blue'); App.renderProfile();" title="Azul Studio (Predefinido)"></button>
                    <button type="button" class="accent-color-btn" style="background:#10b981; outline: ${localStorage.getItem('gv_accent') === 'emerald' || localStorage.getItem('gv_accent') === 'green' ? '2px solid #ffffff' : 'none'}" onclick="App.setAccent('emerald'); App.renderProfile();" title="Verde Esmeralda"></button>
                    <button type="button" class="accent-color-btn" style="background:#f59e0b; outline: ${localStorage.getItem('gv_accent') === 'amber' || localStorage.getItem('gv_accent') === 'orange' ? '2px solid #ffffff' : 'none'}" onclick="App.setAccent('amber'); App.renderProfile();" title="Dourado Âmbar"></button>
                    <button type="button" class="accent-color-btn" style="background:#f43f5e; outline: ${localStorage.getItem('gv_accent') === 'rose' || localStorage.getItem('gv_accent') === 'red' ? '2px solid #ffffff' : 'none'}" onclick="App.setAccent('rose'); App.renderProfile();" title="Rosa Coral"></button>
                    <button type="button" class="accent-color-btn" style="background:#8b5cf6; outline: ${localStorage.getItem('gv_accent') === 'violet' || localStorage.getItem('gv_accent') === 'purple' ? '2px solid #ffffff' : 'none'}" onclick="App.setAccent('violet'); App.renderProfile();" title="Violeta Studio"></button>
                    <button type="button" class="accent-color-btn" style="background:#14b8a6; outline: ${localStorage.getItem('gv_accent') === 'teal' ? '2px solid #ffffff' : 'none'}" onclick="App.setAccent('teal'); App.renderProfile();" title="Verde-azulado Sálvia"></button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;
      } else if (tab === 'api') {
        content.innerHTML = `
          <div class="glass-panel">
            <div class="panel-header"><div class="panel-title">API e Integrações</div></div>
            <div class="panel-body">
              <div class="form-group" style="margin-bottom:0">
                <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 20px; line-height: 1.5;">Gere uma chave API para permitir que ferramentas externas (como scripts de pós-processamento do OrcaSlicer) interajam de forma segura com a sua conta GyroidVault. Mantenha esta chave secreta.</p>
                <div id="api-key-result" style="display:none; margin-bottom:15px; background:rgba(16,185,129,0.1); padding:12px; border-radius:var(--radius-sm); border:1px solid var(--success); color:var(--success); word-break:break-all; font-family:monospace; font-size:0.85rem"></div>
                <button type="button" class="btn btn-secondary" onclick="App.generateApiKey()">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path></svg>
                  Gerar Nova Chave API
                </button>
              </div>
            </div>
          </div>
        `;
      }
    };

    tabs.forEach(t => t.addEventListener('click', () => {
      localStorage.setItem('gv_profile_tab', t.dataset.tab);
      switchTab(t.dataset.tab);
    }));
    
    const defaultTab = localStorage.getItem('gv_profile_tab') || 'account';
    switchTab(defaultTab);
  },

  // ─── Coleções ────────────────────────────────────────────────────────
  cachedProjects: [],
  selectedCollectionIds: [],
  collectionsSortBy: 'recent',
  collectionsSearchQuery: '',
  selectedCollectionModelIds: [],
  currentProject: null,
  collectionModelSearchQuery: '',

  async renderProjects() {
    if (!this.currentUser) {
      this.el.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div><div class="empty-state-text">Inicie sessão para ver coleções</div><div class="empty-state-sub">As coleções são privadas e requerem uma conta</div><button class="btn btn-primary btn-sm" onclick="App.showLogin()" style="margin-top:16px">Iniciar Sessão</button></div>';
      return;
    }
    this.el.innerHTML = '<div class="skeleton-grid"></div>';
    try {
      this.cachedProjects = await API.getProjects();
      this.el.innerHTML = UI.projectsPage(this.cachedProjects, this.collectionsSortBy, this.collectionsSearchQuery);
      this.renderSidebarCollections();
    } catch (e) { this.toast('Falha ao carregar coleções', 'error'); }
  },

  handleCollectionsSearch(query) {
    this.collectionsSearchQuery = query || '';
    this.updateCollectionsGrid();
  },

  handleCollectionsSort(sort) {
    this.collectionsSortBy = sort || 'recent';
    this.updateCollectionsGrid();
  },

  updateCollectionsGrid() {
    const grid = document.getElementById('collections-grid');
    if (!grid) {
      this.el.innerHTML = UI.projectsPage(this.cachedProjects, this.collectionsSortBy, this.collectionsSearchQuery);
      return;
    }
    let filtered = (this.cachedProjects || []).slice();
    if (this.collectionsSearchQuery?.trim()) {
      const q = this.collectionsSearchQuery.toLowerCase().trim();
      filtered = filtered.filter(p => (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
    }
    if (this.collectionsSortBy === 'name') {
      filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else if (this.collectionsSortBy === 'models') {
      filtered.sort((a, b) => (b.model_count || 0) - (a.model_count || 0));
    } else {
      filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }
    grid.innerHTML = filtered.map(p => UI.projectCard(p)).join('') || `
      <div class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
        <div class="empty-state-text">Não foram encontradas coleções</div>
        <div class="empty-state-sub">Tente uma pesquisa diferente</div>
      </div>
    `;
  },

  handleCollectionCardClick(e, id) {
    if (e.target.closest('.model-card-checkbox') || e.target.closest('.model-card-hover-actions') || e.target.closest('button') || e.target.closest('a')) {
      return;
    }
    this.navigate('/projects/' + id);
  },

  toggleCollectionSelection(e, id) {
    e?.stopPropagation();
    const numId = Number(id);
    if (!this.selectedCollectionIds) this.selectedCollectionIds = [];
    const idx = this.selectedCollectionIds.indexOf(numId);
    if (idx >= 0) {
      this.selectedCollectionIds.splice(idx, 1);
    } else {
      this.selectedCollectionIds.push(numId);
    }
    this.el.innerHTML = UI.projectsPage(this.cachedProjects, this.collectionsSortBy, this.collectionsSearchQuery);
  },

  clearCollectionSelection() {
    this.selectedCollectionIds = [];
    this.el.innerHTML = UI.projectsPage(this.cachedProjects, this.collectionsSortBy, this.collectionsSearchQuery);
  },

  async bulkDeleteCollections() {
    if (!this.selectedCollectionIds?.length) return;
    const count = this.selectedCollectionIds.length;
    if (!confirm(`Tem a certeza de que quer eliminar ${count} coleç${count > 1 ? 'ões' : 'ão'}? Os modelos dentro delas permanecerão em segurança na sua biblioteca.`)) return;
    try {
      await API.bulkDeleteProjects(this.selectedCollectionIds);
      this.toast(`${count} coleç${count > 1 ? 'ões eliminadas' : 'ão eliminada'}`);
      this.selectedCollectionIds = [];
      this.renderProjects();
    } catch (e) {
      this.toast(e.message || 'Falha ao eliminar coleções', 'error');
    }
  },

  async bulkSetCollectionsVisibility(visibility) {
    if (!this.selectedCollectionIds?.length) return;
    const count = this.selectedCollectionIds.length;
    try {
      await API.bulkSetProjectsVisibility(this.selectedCollectionIds, visibility);
      this.toast(`${count} coleç${count > 1 ? 'ões atualizadas' : 'ão atualizada'} para ${visibility}`);
      this.selectedCollectionIds = [];
      this.renderProjects();
    } catch (e) {
      this.toast(e.message || 'Falha ao atualizar visibilidade', 'error');
    }
  },

  async renderProjectDetail(id) {
    this.selectedCollectionModelIds = [];
    this.collectionModelSearchQuery = '';
    this.el.innerHTML = '<div class="skeleton-grid"></div>';
    try {
      this.currentProject = await API.getProject(id);
      this.el.innerHTML = UI.projectDetail(this.currentProject, this.collectionModelSearchQuery);
      if (typeof Viewer !== 'undefined' && Viewer.generateThumbnails) {
        setTimeout(() => Viewer.generateThumbnails(), 50);
      }
    } catch (e) { this.toast('Falha ao carregar coleção', 'error'); }
  },

  handleCollectionModelsSearch(query) {
    this.collectionModelSearchQuery = query || '';
    if (this.currentProject) {
      this.el.innerHTML = UI.projectDetail(this.currentProject, this.collectionModelSearchQuery);
    }
  },

  toggleCollectionModelSelection(e, modelId) {
    e?.stopPropagation();
    const numId = Number(modelId);
    if (!this.selectedCollectionModelIds) this.selectedCollectionModelIds = [];
    const idx = this.selectedCollectionModelIds.indexOf(numId);
    if (idx >= 0) {
      this.selectedCollectionModelIds.splice(idx, 1);
    } else {
      this.selectedCollectionModelIds.push(numId);
    }
    if (this.currentProject) {
      this.el.innerHTML = UI.projectDetail(this.currentProject, this.collectionModelSearchQuery);
    }
  },

  clearCollectionModelSelection() {
    this.selectedCollectionModelIds = [];
    if (this.currentProject) {
      this.el.innerHTML = UI.projectDetail(this.currentProject, this.collectionModelSearchQuery);
    }
  },

  async openAddModelsToCollectionModal(projectId) {
    try {
      const res = await API.getModels({ limit: 500 });
      const allModels = res.models || res || [];
      const currentModelIds = (this.currentProject?.models || []).map(m => m.id);
      this.openModal('Adicionar Modelos à Coleção', UI.addModelsToCollectionModal(allModels, currentModelIds, projectId));
    } catch (e) {
      this.toast('Falha ao carregar modelos da biblioteca: ' + e.message, 'error');
    }
  },

  filterModelPickerList(query) {
    const q = (query || '').toLowerCase().trim();
    const items = document.querySelectorAll('#model-picker-list .collection-model-picker-item');
    items.forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = text.includes(q) ? 'flex' : 'none';
    });
  },

  toggleSelectAllPickerModels() {
    const checkboxes = document.querySelectorAll('#model-picker-list input[type="checkbox"]:not([style*="display: none"])');
    if (!checkboxes.length) return;
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !allChecked);
  },

  async handleAddModelsToCollectionSubmit(e, projectId) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const modelIds = fd.getAll('model_ids').map(Number);
    try {
      // Primeiro, obter os modelos atualmente atribuídos para calcular adições e remoções
      const currentIds = (this.currentProject?.models || []).map(m => m.id);
      const toAdd = modelIds.filter(id => !currentIds.includes(id));
      const toRemove = currentIds.filter(id => !modelIds.includes(id));

      if (toAdd.length > 0) {
        await API.bulkAddModelsToProject(projectId, toAdd);
      }
      if (toRemove.length > 0) {
        await API.bulkRemoveModelsFromProject(projectId, toRemove);
      }

      this.toast(`Coleção atualizada (${toAdd.length} adicionados, ${toRemove.length} removidos)`);
      this.closeModal();
      this.renderProjectDetail(projectId);
      this.renderSidebarCollections();
    } catch (err) {
      this.toast(err.message || 'Falha ao atualizar modelos da coleção', 'error');
    }
  },

  async removeFromProject(projectId, modelId) {
    if (!confirm('Remover este modelo da coleção?')) return;
    try {
      await API.removeModelFromProject(projectId, modelId);
      this.toast('Modelo removido da coleção');
      this.renderProjectDetail(projectId);
      this.renderSidebarCollections();
    } catch (e) {
      this.toast(e.message || 'Falha ao remover modelo', 'error');
    }
  },

  async bulkRemoveFromCollection(projectId) {
    if (!this.selectedCollectionModelIds?.length) return;
    const count = this.selectedCollectionModelIds.length;
    if (!confirm(`Remover ${count} modelo${count > 1 ? 's' : ''} desta coleção?`)) return;
    try {
      await API.bulkRemoveModelsFromProject(projectId, this.selectedCollectionModelIds);
      this.toast(`${count} modelo${count > 1 ? 's removidos' : ' removido'} da coleção`);
      this.selectedCollectionModelIds = [];
      this.renderProjectDetail(projectId);
      this.renderSidebarCollections();
    } catch (e) {
      this.toast(e.message || 'Falha na remoção em massa', 'error');
    }
  },

  async bulkAddSelectedToAnotherCollection(currentProjectId) {
    if (!this.selectedCollectionModelIds?.length) return;
    try {
      const projects = await API.getProjects();
      const otherProjects = projects.filter(p => p.id !== Number(currentProjectId));
      if (!otherProjects.length) {
        this.toast('Não foram encontradas outras coleções para copiar', 'error');
        return;
      }
      this.openModal('Copiar Modelos para a Coleção', UI.collectionSelectForm(otherProjects, [], null));
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  downloadCollectionZip(projectId) {
    this.toast('A gerar ZIP da coleção...', 'info');
    const a = document.createElement('a');
    a.href = `/api/projects/${projectId}/download`;
    a.download = `collection_${projectId}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  showCreateProject() {
    this.openModal('Nova Coleção', UI.projectForm());
  },

  async handleProjectSubmit(e, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {
      name: fd.get('name'),
      description: fd.get('description'),
      visibility: fd.get('visibility') || 'public'
    };
    try {
      if (id) {
        await API.updateProject(id, data);
        this.toast('Coleção atualizada');
        this.closeModal();
        if (location.hash.startsWith('#/projects/') || location.hash.startsWith('#/collections/')) {
          this.renderProjectDetail(id);
        } else {
          this.renderProjects();
        }
      } else {
        await API.createProject(data);
        this.toast('Coleção criada');
        this.closeModal();
        this.renderProjects();
      }
      this.renderSidebarCollections();
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async openEditProjectModal(projectId) {
    try {
      const project = await API.getProject(projectId);
      this.openModal('Editar Coleção', UI.editProjectModal(project));
    } catch (e) {
      this.toast('Falha ao carregar coleção: ' + e.message, 'error');
    }
  },

  async handleProjectUpdateSubmit(e, projectId) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {
      name: fd.get('name'),
      description: fd.get('description'),
      visibility: fd.get('visibility')
    };
    try {
      await API.updateProject(projectId, data);
      this.toast('Coleção atualizada');
      this.closeModal();
      if (location.hash.startsWith('#/projects/') || location.hash.startsWith('#/collections/')) {
        this.renderProjectDetail(projectId);
      } else {
        this.renderProjects();
      }
      this.renderSidebarCollections();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async deleteProject(id) {
    if (!confirm('Tem a certeza de que quer eliminar esta coleção? Os modelos não serão eliminados.')) return;
    try {
      await API.deleteProject(id);
      this.toast('Coleção eliminada');
      this.navigate('/collections');
      this.renderSidebarCollections();
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async addToProject(modelId) {
    return this.openModelCollectionsModal(modelId);
  },

  async openModelCollectionsModal(modelId) {
    try {
      const [model, projects] = await Promise.all([API.getModel(modelId), API.getProjects()]);
      const selectedIds = (model.projects || []).map(p => p.id);
      this.openModal('Gerir Coleções', UI.collectionSelectForm(projects, selectedIds, modelId));
    } catch (e) {
      this.toast('Falha ao carregar coleções: ' + e.message, 'error');
    }
  },

  async handleCollectionSelectionSubmit(e, modelId) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const selectedProjectIds = fd.getAll('project_ids').map(Number);
    try {
      if (modelId) {
        await API.syncModelProjects(modelId, selectedProjectIds);
        this.toast('Coleções atualizadas com sucesso');
        this.closeModal();
        if (location.hash.startsWith('#/models/')) {
          this.renderModelDetail(modelId);
        } else {
          this.fetchAndRenderModels();
        }
      } else if (this.selectedModelIds?.length > 0) {
        // Adição em massa
        for (const pid of selectedProjectIds) {
          await API.bulkAddModelsToProject(pid, this.selectedModelIds);
        }
        this.toast(`${this.selectedModelIds.length} modelos adicionados a ${selectedProjectIds.length} coleção(ões)`);
        this.clearSelection();
        this.closeModal();
      }
      this.renderSidebarCollections();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  filterCollectionList(query) {
    const q = (query || '').toLowerCase().trim();
    const items = document.querySelectorAll('.collection-checkbox-item');
    items.forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = text.includes(q) ? 'flex' : 'none';
    });
  },

  // ─── Partilha ─────────────────────────────────────────────────────────
  showShareModal(modelId) {
    this.openModal('Partilhar Modelo', UI.shareModal(modelId));
  },

  async generateShare(modelId) {
    const days = document.getElementById('share-expiry').value;
    try {
      const { slug } = await API.createShare(modelId, days);
      const link = `${window.location.origin}/#/share/${slug}`;
      const res = document.getElementById('share-result');
      const input = document.getElementById('share-link-input');
      input.value = link;
      res.style.display = 'block';
    } catch (e) { this.toast(e.message, 'error'); }
  },

  copyShareLink() {
    const input = document.getElementById('share-link-input');
    if (input) {
      this.copyToClipboard(input.value, 'Link copiado para a área de transferência');
    }
  },

  showCreateVersion(id, name) {
    const modelName = name || this.currentModel?.name || 'Modelo';
    const safeName = UI.escapeHtml(modelName);
    const html = `
      <form onsubmit="App.handleVersionSubmit(event, ${id})" class="form-grid">
        <div class="form-group">
          <label>Nome da Versão</label>
          <input type="text" name="name" value="${safeName} (v2)" required class="form-input" placeholder="ex.: O Meu Modelo v2">
        </div>
        <div class="form-group">
          <label>Descrição das alterações (opcional)</label>
          <textarea name="description" class="form-textarea" placeholder="O que mudou nesta versão?"></textarea>
        </div>
        <div style="margin-top:20px;display:flex;justify-content:flex-end;gap:8px">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Cancelar</button>
          <button type="submit" class="btn btn-primary">Criar Versão</button>
        </div>
      </form>`;
    this.openModal('Nova Versão', html);
  },

  async handleVersionSubmit(e, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = { name: fd.get('name'), description: fd.get('description') };
    try {
      const res = await API.createVersion(id, data);
      this.toast('Versão criada');
      this.closeModal();
      this.navigate(`/models/${res.id}`);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async renderSharedModel(slug) {
    this.el.innerHTML = '<div style="padding:40px;text-align:center">A carregar modelo partilhado...</div>';
    try {
      const model = await API.getSharedModel(slug);
      this.el.innerHTML = UI.publicModelDetail(model);
      
      const stlFile = model.files.find(f => f.file_type === 'stl') || model.files.find(f => f.file_type === '3mf') || model.files.find(f => f.file_type === 'step');
      if (stlFile && typeof Viewer !== 'undefined') {
        setTimeout(() => {
          Viewer.create('public-viewer', stlFile.url, stlFile.file_type);
        }, 100);
      }
    } catch (e) {
      this.el.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent-yellow)"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="empty-state-text">Link de partilha inválido ou expirado</div></div>`;
    }
  },

  openInSlicer(fileUrl, slicer) {
    const absoluteUrl = window.location.origin + fileUrl;
    let protocol = '';
    if (slicer === 'bambustudio') protocol = 'bambustudio://open?file=';
    else if (slicer === 'prusaslicer') protocol = 'prusaslicer://';
    else if (slicer === 'orcaslicer') protocol = 'orcaslicer://open?file=';
    
    if (protocol) {
      window.location.href = protocol + absoluteUrl;
      this.toast(`A abrir em ${slicer}...`);
    } else {
      // Alternativa para o Cura: apenas descarregar?
      window.open(fileUrl, '_blank');
    }
  },

  // ─── Detalhe do Modelo ────────────────────────────────────────────────────
  async renderModelDetail(id) {
    if (typeof Viewer !== 'undefined') Viewer.cleanup();
    this.el.innerHTML = '<div style="padding:40px;text-align:center"><div class="skeleton" style="width:200px;height:30px;margin:0 auto 20px"></div><div class="skeleton" style="width:100%;height:200px"></div></div>';
    try {
      const model = await API.getModel(id);
      const config = await API.getSystemSettings().catch(() => ({}));
      let printers = [];
      try { if (config.printers) printers = JSON.parse(config.printers); } catch(e){}
      const hasPrinters = printers.length > 0;

      this.el.innerHTML = `
        ${UI.modelDetail(model, hasPrinters)}`;
      // Iniciar o visualizador 3D com o ficheiro de pré-visualização 3D escolhido ou o primeiro stl/3mf
      const files = model.files || [];
      const cadFiles = files.filter(f => f.file_type === 'stl' || f.file_type === '3mf' || f.file_type === 'step');
      const previewCadFile = (model.preview_file_id && cadFiles.find(f => f.id === model.preview_file_id)) ||
        cadFiles[0];

      if (previewCadFile && typeof Viewer !== 'undefined') {
        const stlUrl = `${previewCadFile.url || '/uploads/'+previewCadFile.filename}?t=${Date.now()}`;
        setTimeout(async () => {
          const v = Viewer.create(`stl-viewer-${model.id}`, stlUrl, previewCadFile.file_type, {
            modelId: model.id,
            activeFileId: previewCadFile.id,
            modelFiles: cadFiles
          });
          if (v && !model.thumbnail_url && !model.thumbnail) {
            Promise.resolve(v.ready).then(() => {
              setTimeout(() => Viewer.takeSnapshot(model.id, v.renderer, v.scene, v.camera), 2500);
            });
          }
        }, 100);
      }
    } catch (e) {
      this.el.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent-yellow)"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div><div class="empty-state-text">Modelo não encontrado</div></div>';
    }
  },

  async setPreviewFile(modelId, fileId) {
    try {
      await API.setPreviewFile(modelId, fileId);
      this.toast('Ficheiro de pré-visualização principal atualizado');
      this.renderModelDetail(modelId);
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  switchModelDetailTab(tabName) {
    document.querySelectorAll('.model-detail-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.model-detail-tab-pane').forEach(pane => {
      pane.style.display = pane.id === `tab-pane-${tabName}` ? 'block' : 'none';
    });
  },

  setDefaultMaterial(val) {
    localStorage.setItem('gv_default_material', val);
    this.toast('Material de impressão predefinido atualizado');
  },

  toggleDescTab(tab) {
    const writeTab = document.getElementById('desc-tab-write');
    const prevTab = document.getElementById('desc-tab-preview');
    const input = document.getElementById('model-description-input');
    const preview = document.getElementById('model-description-preview');
    if (!writeTab || !prevTab || !input || !preview) return;

    if (tab === 'write') {
      writeTab.classList.add('active');
      prevTab.classList.remove('active');
      input.style.display = 'block';
      preview.style.display = 'none';
    } else {
      prevTab.classList.add('active');
      writeTab.classList.remove('active');
      input.style.display = 'none';
      preview.style.display = 'block';
      preview.innerHTML = UI.renderMarkdown(input.value) || '<div style="color:var(--text-muted);font-style:italic">Ainda não foi inserida uma descrição.</div>';
    }
  },

  openBrowseFileModal(fileJsonEncoded) {
    let file;
    try {
      file = JSON.parse(decodeURIComponent(fileJsonEncoded));
    } catch (e) {
      console.error('Falha ao processar json do ficheiro', e);
      return;
    }

    const is3D = file.type === 'stl' || file.type === '3mf' || file.type === 'step';
    const isGcode = file.type === 'gcode';
    const meta = file.metadata || {};

    let metadataRows = '';
    const metaEntries = [];
    if (meta.printTime) metaEntries.push({ label: 'Tempo Estim. de Impressão', val: meta.printTime });
    if (meta.filamentType) metaEntries.push({ label: 'Filamento', val: meta.filamentType });
    if (meta.tempNozzle) metaEntries.push({ label: 'Temp. do Bico', val: `${meta.tempNozzle}°C` });
    if (meta.tempBed) metaEntries.push({ label: 'Temp. da Mesa', val: `${meta.tempBed}°C` });
    if (meta.layerHeight) metaEntries.push({ label: 'Altura da Camada', val: `${meta.layerHeight} mm` });
    if (meta.fillDensity) metaEntries.push({ label: 'Preenchimento', val: meta.fillDensity });
    if (meta.slicer) metaEntries.push({ label: 'Slicer', val: meta.slicer });
    if (meta.printerModel) metaEntries.push({ label: 'Modelo da Impressora', val: meta.printerModel });
    if (meta.filamentWeight) metaEntries.push({ label: 'Filamento Usado', val: `${meta.filamentWeight}g` });

    if (metaEntries.length > 0) {
      metadataRows = `
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(130px, 1fr));gap:8px;margin-bottom:16px">
          ${metaEntries.map(e => `
            <div style="background:var(--bg-input);padding:8px 10px;border-radius:var(--radius-sm);border:1px solid var(--border)">
              <div style="color:var(--text-muted);font-size:0.65rem;text-transform:uppercase;letter-spacing:0.05em">${e.label}</div>
              <div style="font-weight:600;font-size:0.85rem;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.val}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    let viewerArea = '';
    if (is3D || isGcode) {
      viewerArea = `
        <div id="browse-file-viewer-container" style="width:100%;height:320px;background:var(--bg-secondary);border-radius:var(--radius-md);overflow:hidden;position:relative;margin-bottom:16px;border:1px solid var(--border)">
          <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">A carregar Pré-visualização 3D...</div>
        </div>
      `;
    } else if (file.type === 'image') {
      viewerArea = `
        <div style="width:100%;max-height:360px;display:flex;align-items:center;justify-content:center;background:var(--bg-secondary);border-radius:var(--radius-md);overflow:hidden;margin-bottom:16px;border:1px solid var(--border)">
          <img src="${file.url}" style="max-width:100%;max-height:360px;object-fit:contain" alt="${file.name}">
        </div>
      `;
    }

    const modalContent = `
      <div>
        ${viewerArea}
        ${metadataRows}
        <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap">
          <div style="font-size:0.8rem;color:var(--text-muted);display:flex;align-items:center;gap:6px">
            <span>Tamanho: <strong>${UI.formatSize(file.size)}</strong></span>
            ${file.folderPath ? `<span>·</span><span style="display:inline-flex;align-items:center;gap:3px;color:#f59e0b"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>${file.folderPath}</span>` : ''}
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${(is3D || isGcode) ? `<button class="btn btn-secondary btn-sm" onclick="App.previewFileModal('${file.url}', '${file.name.replace(/'/g, "\\'")}', '${file.type}')">Ecrã Inteiro</button>` : ''}
            ${file.id ? `<a href="/api/files/${file.id}/download" class="btn btn-primary btn-sm" download>Transferir</a>` : `<a href="${file.url}" class="btn btn-primary btn-sm" download="${file.name}">Transferir</a>`}
          </div>
        </div>
      </div>
    `;

    this.openModal(file.name, modalContent);

    if (is3D || isGcode) {
      setTimeout(() => {
        if (typeof Viewer !== 'undefined') {
          Viewer.create('browse-file-viewer-container', file.url, file.type);
        }
      }, 100);
    }
  },

  scanPollTimer: null,

  async handleScanLibrary() {
    return this.scanLibrary();
  },

  async scanLibrary() {
    const btn = document.getElementById('scan-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon rotating"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg></span> A iniciar...';
    }

    try {
      const csrfToken = localStorage.getItem('pv_csrf_token');
      const res = await fetch('/api/library/scan', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': csrfToken }
      });
      const data = await res.json();
      if (res.ok || res.status === 409) {
        this.toast(res.status === 409 ? 'Já existe uma análise em curso. A monitorizar...' : 'Análise da biblioteca iniciada em segundo plano.');
        this.monitorScanProgress();
      } else {
        if (res.status === 401) this.toast('Inicie sessão como administrador para analisar', 'error');
        else this.toast('Falha ao iniciar a análise: ' + (data.error || 'Erro desconhecido'), 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span class="btn-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg></span> Analisar Biblioteca';
        }
      }
    } catch (e) {
      console.error(e);
      this.toast('Falha ao contactar o servidor para iniciar a análise', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg></span> Analisar Biblioteca';
      }
    }
  },

  monitorScanProgress() {
    if (this.scanPollTimer) return;

    const updateUI = (status) => {
      const btn = document.getElementById('scan-btn');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="btn-icon rotating"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg></span> ${status.foldersScanned || 0} pastas (${status.filesAdded || 0} ficheiros)`;
      }
    };

    this.scanPollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/library/scan/status', { credentials: 'same-origin' });
        if (!res.ok) return;
        const status = await res.json();

        if (status.isScanning) {
          updateUI(status);
        } else {
          clearInterval(this.scanPollTimer);
          this.scanPollTimer = null;

          const btn = document.getElementById('scan-btn');
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg></span> Analisar Biblioteca';
          }

          if (status.error) {
            this.toast('Análise interrompida com erro: ' + status.error, 'error');
          } else {
            const addedModels = status.lastResults?.modelsAdded || 0;
            const addedFiles = status.lastResults?.filesAdded || 0;
            this.toast(`✓ Análise concluída! ${addedModels} modelos e ${addedFiles} ficheiros adicionados (${status.elapsedSeconds || 0}s).`);
            this.fetchAndRenderModels();
          }
        }
      } catch (e) {
        console.warn('Não foi possível consultar o estado da análise:', e);
      }
    }, 1500);
  },

  previewFileModal(url, name, fileType = null) {
    if (typeof Viewer === 'undefined') return;
    const modalHtml = `
      <div class="modal-overlay active" id="preview-file-overlay" style="z-index:9999;background:rgba(0,0,0,0.85)">
        <div class="modal" style="width:96vw;max-width:1400px;height:92vh;max-height:92vh;display:flex;flex-direction:column;overflow:hidden">
          <div class="modal-header" style="padding:16px 24px">
            <h5 class="modal-title" style="margin:0">${name}</h5>
            <button type="button" class="modal-close" onclick="App.closePreviewFileModal(event)">✕</button>
          </div>
          <div class="modal-body" style="flex:1;padding:0;overflow:hidden;position:relative">
            <div id="full-preview-viewer" style="width:100%;height:100%">
              <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">A carregar Visualizador 3D...</div>
            </div>
          </div>
        </div>
      </div>
    `;
    const container = document.createElement('div');
    container.id = 'preview-modal-container';
    container.innerHTML = modalHtml;
    document.body.appendChild(container);

    const overlay = container.querySelector('#preview-file-overlay');
    let overlayDown = false;
    if (overlay) {
      overlay.addEventListener('mousedown', (e) => {
        overlayDown = (e.target === overlay);
      });
      overlay.addEventListener('mouseup', (e) => {
        if (overlayDown && e.target === overlay) {
          this.closePreviewFileModal();
        }
        overlayDown = false;
      });
    }
    
    this.previewKeyHandler = (e) => { if (e.key === 'Escape') this.closePreviewFileModal(); };
    document.addEventListener('keydown', this.previewKeyHandler);
    
    const resolvedType = fileType || (name.toLowerCase().endsWith('.3mf') ? '3mf' : (name.toLowerCase().endsWith('.gcode') || name.toLowerCase().endsWith('.bgcode') ? 'gcode' : 'stl'));

    setTimeout(() => {
      Viewer.create('full-preview-viewer', url, resolvedType);
    }, 100);
  },

  closePreviewFileModal(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (typeof Viewer !== 'undefined') Viewer.cleanup();
    const el = document.getElementById('preview-modal-container');
    if (el) el.remove();
    if (this.previewKeyHandler) {
      document.removeEventListener('keydown', this.previewKeyHandler);
      this.previewKeyHandler = null;
    }
  },

  previewStl(modelId, url, fileType = null) {
    if (typeof Viewer === 'undefined') return;
    Viewer.cleanup();
    const container = document.getElementById(`stl-viewer-${modelId}`);
    if (container) {
      if (container.nextElementSibling) {
        container.nextElementSibling.style.visibility = 'visible';
      }
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">A carregar...</div>';
      container.dataset.stlUrl = url;
      setTimeout(() => {
        Viewer.create(`stl-viewer-${modelId}`, url, fileType);
      }, 50);
    }
  },

  async renderSettings(initialTab = 'categories') {
    const isAdmin = this.currentUser?.role === 'admin';

    this.el.innerHTML = `
      <div class="page-header" style="margin-bottom:20px">
        <div>
          <h1 class="page-title">Definições</h1>
          <p class="page-subtitle">Configure e personalize a sua instância do GyroidVault 2.0</p>
        </div>
      </div>

      <div class="settings-layout">
        <!-- Modern Left Navigation Sub-Sidebar -->
        <aside class="settings-nav-sidebar">
          <div class="settings-nav-group">
            <div class="settings-nav-group-title">Taxonomias</div>
            <button class="settings-nav-btn active" data-tab="categories">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <span>Categorias</span>
            </button>
            <button class="settings-nav-btn" data-tab="tags">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
              <span>Etiquetas</span>
            </button>
            <button class="settings-nav-btn" data-tab="materials">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
              <span>Materiais</span>
            </button>
          </div>

          ${isAdmin ? `
            <div class="settings-nav-group">
              <div class="settings-nav-group-title">Hardware</div>
              <button class="settings-nav-btn" data-tab="printers">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                <span>Impressoras 3D</span>
              </button>
              <button class="settings-nav-btn" data-tab="smtp">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                <span>SMTP e Correio</span>
              </button>
            </div>

            <div class="settings-nav-group">
              <div class="settings-nav-group-title">Administração</div>
              <button class="settings-nav-btn" data-tab="security">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <span>Segurança</span>
              </button>
              <button class="settings-nav-btn" data-tab="users">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                <span>Utilizadores e Funções</span>
              </button>
              <button class="settings-nav-btn" data-tab="system">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                <span>Sistema</span>
              </button>
              <button class="settings-nav-btn" data-tab="maintenance">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <span>Manutenção e Registos</span>
              </button>
            </div>
          ` : ''}

          <div class="settings-nav-group">
            <div class="settings-nav-group-title">Informação do Sistema</div>
            <button class="settings-nav-btn" data-tab="about">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              <span>Sobre o GyroidVault</span>
            </button>
          </div>
        </aside>

        <!-- Right Content Area -->
        <main id="settings-content" style="min-width:0"></main>
      </div>`;

    const content = this.el.querySelector('#settings-content');
    const navBtns = this.el.querySelectorAll('.settings-nav-btn');

    const switchTab = async (tab) => {
      navBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
      });
      content.innerHTML = '<div class="skeleton" style="height:320px;width:100%;border-radius:10px"></div>';

      try {
        if (tab === 'categories') {
          const cats = await API.getCategories();
          content.innerHTML = `<div class="settings-grid">${UI.settingsPanel('Categorias', cats, 'categories')}</div>`;
        } else if (tab === 'tags') {
          const tags = await API.getTags();
          content.innerHTML = `<div class="settings-grid">${UI.settingsPanel('Etiquetas', tags, 'tags')}</div>`;
        } else if (tab === 'materials') {
          const mats = await API.getMaterials();
          content.innerHTML = `<div class="settings-grid">${UI.settingsPanel('Materiais', mats, 'materials')}</div>`;
        } else if (tab === 'printers') {
          const config = await API.getSystemSettings();
          let printers = [];
          try { if (config.printers) printers = JSON.parse(config.printers); } catch(e){}
          content.innerHTML = `
            <div class="glass-panel">
              <div class="panel-header"><div class="panel-title"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>Impressoras 3D (Moonraker)</div></div>
              <div class="panel-body">${UI.printersSettingsForm(printers)}</div>
            </div>`;
        } else if (tab === 'security') {
          const config = await API.getSystemSettings();
          content.innerHTML = `
            <div class="glass-panel">
              <div class="panel-header"><div class="panel-title"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Segurança e Controlo de Acesso</div></div>
              <div class="panel-body">${UI.securitySettingsForm(config)}</div>
            </div>`;
          setTimeout(() => App.loadBlockedIps(), 50);
        } else if (tab === 'maintenance') {
          const logs = await API.getSystemLogs();
          content.innerHTML = `
            <div class="glass-panel" style="margin-bottom:24px">
              <div class="panel-header"><div class="panel-title"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Manutenção e Duplicados</div></div>
              <div class="panel-body">${UI.maintenanceSettingsForm()}</div>
            </div>
            <div class="glass-panel">
              <div class="panel-header">
                <div class="panel-title">Registos de Eventos do Sistema</div>
                <button class="btn btn-ghost btn-xs" onclick="App.handleClearLogs()" style="color:var(--error)">Limpar Registos</button>
              </div>
              <div class="panel-body no-pad">
                <div id="system-logs-list" style="max-height:400px;overflow-y:auto;font-family:monospace;font-size:.75rem">
                  ${logs.length ? logs.map(l => `
                    <div style="padding:8px 16px;border-bottom:1px solid var(--border);display:flex;gap:12px;${l.level === 'warning' ? 'background:rgba(245,158,11,0.05);' : ''}">
                      <span style="color:var(--text-muted);white-space:nowrap">${new Date(l.created_at).toLocaleString()}</span>
                      <span style="color:var(--accent-${l.level === 'warning' ? 'pink' : 'cyan'});font-weight:700;width:60px">[${l.level.toUpperCase()}]</span>
                      <span style="color:var(--text-secondary)">${l.message}</span>
                    </div>
                  `).join('') : '<div style="padding:20px;text-align:center;color:var(--text-muted)">Sem registos disponíveis</div>'}
                </div>
              </div>
            </div>`;
        } else if (tab === 'smtp') {
          const config = await API.getSMTPSettings();
          content.innerHTML = `
            <div class="glass-panel">
              <div class="panel-header"><div class="panel-title">Configuração de Correio SMTP</div></div>
              <div class="panel-body">${UI.smtpSettingsForm(config)}</div>
            </div>`;
        } else if (tab === 'system') {
          const config = await API.getSystemSettings();
          content.innerHTML = `
            <div class="glass-panel">
              <div class="panel-header"><div class="panel-title">Definições do Sistema</div></div>
              <div class="panel-body">${UI.systemSettingsForm(config)}</div>
            </div>`;
        } else if (tab === 'users') {
          const users = await API.getUsers();
          content.innerHTML = `
            <div class="glass-panel" style="margin-bottom:20px">
              <div class="panel-header"><div class="panel-title">Convidar Utilizador</div></div>
              <div class="panel-body">
                <form onsubmit="App.handleInviteUser(event)" style="display:flex;gap:10px;flex-wrap:wrap">
                  <input type="email" name="email" required placeholder="Endereço de e-mail a convidar" class="form-input" style="max-width:320px">
                  <button type="submit" class="btn btn-primary">Enviar Convite</button>
                </form>
              </div>
            </div>
            <div class="glass-panel">
              <div class="panel-header"><div class="panel-title">Contas de Utilizador e Funções</div></div>
              <div class="panel-body no-pad" style="overflow-x:auto">
                <table class="settings-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Nome de Utilizador</th>
                      <th>E-mail</th>
                      <th>Função</th>
                      <th style="text-align:right">Ações</th>
                    </tr>
                  </thead>
                  <tbody>${users.map(u => `
                    <tr>
                      <td>#${u.id}</td>
                      <td style="font-weight:600;color:var(--text-primary)">${u.username}</td>
                      <td>${u.email || '-'}</td>
                      <td>
                        <select class="form-input" style="padding:4px 8px;font-size:.85rem;width:auto;display:inline-block" onchange="App.changeUserRole(${u.id}, this)" ${u.id === 1 ? 'disabled' : ''}>
                          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option>
                          <option value="uploader" ${u.role === 'uploader' ? 'selected' : ''}>Autor do Envio</option>
                          <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Visualizador</option>
                        </select>
                        ${u.id === 1 ? '<span style="font-size:0.7rem;color:var(--accent-cyan);margin-left:6px;font-weight:600">Administrador Principal</span>' : ''}
                      </td>
                      <td style="text-align:right">
                        ${u.id !== 1 ? `<button class="btn btn-danger btn-xs" onclick="App.deleteUser(${u.id})" style="display:inline-flex;align-items:center;gap:4px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>Eliminar</button>` : ''}
                      </td>
                    </tr>`).join('')}
                  </tbody>
                </table>
              </div>
            </div>`;
        } else if (tab === 'about') {
          content.innerHTML = UI.aboutSection({ currentVersion: '2.0.2' });
        }
      } catch (e) { console.error(e); }
    };

    navBtns.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    switchTab(initialTab);
  },

  // ─── Ações ──────────────────────────────────────────────────────────
  async showCreateModel() {
    await this.loadCache();
    this.pendingFiles = [];
    let formHtml = UI.modelForm(null, this.cache.categories, this.cache.tags);
    
    if (this.libraryViewMode === 'folder' && this.currentBrowsePath) {
      const folderOptionsHtml = `
        <div class="form-group">
          <input type="hidden" name="parent_folder" value="${this.currentBrowsePath}">
          <label><input type="checkbox" name="create_subfolder" value="true" checked> Criar subpasta para este modelo</label>
        </div>
      `;
      // Inserir antes de form-actions
      formHtml = formHtml.replace('<div class="form-actions">', folderOptionsHtml + '<div class="form-actions">');
    }
    
    this.openModal('Novo Modelo', formHtml);
    setTimeout(() => document.getElementById('model-name-input')?.focus(), 100);
  },



  handleCreateFileSelect(e) {
    const files = Array.from(e.target.files);
    this.addPendingFiles(files);
  },

  handleCreateFileDrop(e) {
    const files = Array.from(e.dataTransfer.files);
    this.addPendingFiles(files);
  },

  switchFilesTab(e, tab) {
    const container = e.target.closest('.glass-panel');
    const tabEl = e.currentTarget || e.target.closest('div[onclick]');
    const tabs = container.querySelectorAll('.panel-header div[onclick]');
    tabs.forEach(t => {
      t.style.borderBottomColor = 'transparent';
      t.style.color = 'var(--text-muted)';
    });
    if (tabEl) {
      tabEl.style.borderBottomColor = 'var(--accent-cyan)';
      tabEl.style.color = 'var(--text)';
    }
    
    container.querySelector('#tab-content-files').style.display = tab === 'files' ? 'block' : 'none';
    const docsContent = container.querySelector('#tab-content-docs');
    if(docsContent) docsContent.style.display = tab === 'docs' ? 'block' : 'none';
  },

  addPendingFiles(files) {
    const MAX_SIZE = 500 * 1024 * 1024; // 500MB
    const validFiles = [];
    for (const f of files) {
      if (f.size > MAX_SIZE) {
        this.toast(`O ficheiro "${f.name}" excede o limite de tamanho de 500MB.`, 'error');
      } else {
        validFiles.push(f);
      }
    }
    if (validFiles.length) {
      this.pendingFiles.push(...validFiles);
      this.renderPendingFiles();
    }
  },

  removePendingFile(index) {
    this.pendingFiles.splice(index, 1);
    this.renderPendingFiles();
  },

  renderPendingFiles() {
    const list = document.getElementById('create-file-list');
    if (!list) return;
    if (!this.pendingFiles.length) { list.style.display = 'none'; return; }
    list.style.display = 'block';
    list.innerHTML = this.pendingFiles.map((f, i) =>
      `<div class="upload-file-item">
        <span class="badge badge-${f.name.split('.').pop().toLowerCase()}">${f.name.split('.').pop().toUpperCase()}</span>
        <span>${f.name}</span>
        <span style="color:var(--text-muted);font-size:.7rem">${UI.formatSize(f.size)}</span>
        <button class="remove-file" onclick="event.preventDefault();App.removePendingFile(${i})">×</button>
      </div>`
    ).join('');
  },

  addInlineTag() {
    const input = document.getElementById('new-tag-input');
    const container = document.getElementById('model-tags-container');
    if (!input || !container) return;
    const val = input.value.trim();
    if (!val) return;
    
    const label = document.createElement('label');
    label.className = 'tag-pill-checkbox';
    // Usar um prefixo para identificar como uma nova etiqueta em vez de um ID
    label.innerHTML = `
      <input type="checkbox" name="tags" value="NEW:${val}" checked> 
      <span class="tag-pill new">${val}</span>`;
    container.appendChild(label);
    input.value = '';
    input.focus();
  },

  addCustomMetaField() {
    const container = document.getElementById('custom-meta-container');
    if (!container) return;
    const div = document.createElement('div');
    div.style.cssText = 'display:flex; gap:8px; margin-bottom:8px;';
    div.className = 'custom-meta-row';
    div.innerHTML = `
      <input type="text" class="form-input" name="meta_keys[]" placeholder="Chave (ex.: Designer)" style="flex:1" required>
      <input type="text" class="form-input" name="meta_values[]" placeholder="Valor" style="flex:2" required>
      <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove()">X</button>
    `;
    container.appendChild(div);
  },

  async showEditModel(id) {
    try {
      const [model] = await Promise.all([API.getModel(id), this.loadCache()]);
      this.openModal('Editar Modelo', UI.modelForm(model, this.cache.categories, this.cache.tags));
    } catch (e) { this.toast('Falha ao carregar modelo', 'error'); }
  },

  async handleModelSubmit(e, id) {
    e.preventDefault();
    const form = new FormData(e.target);
    const tags = Array.from(e.target.querySelectorAll('input[name="tags"]:checked')).map(c => {
      if (c.value.startsWith('NEW:')) return c.value.substring(4);
      return parseInt(c.value);
    });
    
    const metaKeys = form.getAll('meta_keys[]');
    const metaValues = form.getAll('meta_values[]');
    const customMeta = {};
    for (let i = 0; i < metaKeys.length; i++) {
      if (metaKeys[i].trim()) customMeta[metaKeys[i].trim()] = metaValues[i].trim();
    }
    
    const data = {
      name: form.get('name'),
      description: form.get('description'),
      print_tips: form.get('print_tips'),
      source_url: form.get('source_url'),
      category_id: form.get('category_id') || null,
      custom_meta: customMeta,
      tags,
    };
    
    if (form.has('parent_folder')) {
      data.parent_folder = form.get('parent_folder');
    }
    if (form.has('create_subfolder')) {
      data.create_subfolder = form.get('create_subfolder') === 'true';
    }

    try {
      if (id) {
        await API.updateModel(id, data);
        this.toast('Modelo atualizado');
        this.closeModal();
        this.renderModelDetail(id);
      } else {
        const model = await API.createModel(data);
        // Enviar ficheiros pendentes, se existirem
        if (this.pendingFiles.length > 0) {
          const submitBtn = document.getElementById('model-submit-btn');
          if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = 'A enviar ficheiros...'; }
          const progress = document.getElementById('create-upload-progress');
          try {
            const uploadOpts = {
              parent_folder: data.parent_folder,
              create_subfolder: data.create_subfolder
            };
            await API.uploadFiles(model.id, this.pendingFiles, uploadOpts, (p) => {
              if (progress) progress.innerHTML = UI.uploadProgressBox(p);
            });
            this.toast(`Modelo criado com ${this.pendingFiles.length} ficheiro(s)`);
          } catch (ue) {
            this.toast('Modelo criado mas o envio do ficheiro falhou: ' + ue.message, 'error');
          }
          this.pendingFiles = [];
        } else {
          this.toast('Modelo criado');
        }
        this.closeModal();
        this.navigate(`/models/${model.id}`);
      }
    } catch (e) {
      if (e.suggested_names?.length || e.suggested_name || (e.message && e.message.includes('already exists'))) {
        const banner = document.getElementById('duplicate-warning-banner');
        const warnText = document.getElementById('duplicate-warning-text');
        const container = document.getElementById('duplicate-suggestions-container');
        if (banner) {
          banner.style.display = 'block';
          if (warnText) warnText.textContent = e.message || 'Já existe um modelo com este nome.';
          const suggestions = e.suggested_names && e.suggested_names.length ? e.suggested_names : (e.suggested_name ? [e.suggested_name] : []);
          this.pendingSuggestedName = suggestions[0] || null;
          if (container) {
            container.innerHTML = suggestions.map(s => `
              <button type="button" class="btn btn-secondary btn-xs" onclick="App.applySuggestedName('${s.replace(/'/g, "\\'")}')" style="background:var(--bg-input);border:1px solid var(--border-hover);color:var(--text-primary);padding:4px 10px;font-size:0.75rem;border-radius:6px;display:inline-flex;align-items:center;gap:4px">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> ${s}
              </button>
            `).join('');
          }
          return;
        }
      }
      this.toast(e.message, 'error');
    }
  },

  applySuggestedName(chosenName = null) {
    const nameToUse = chosenName || this.pendingSuggestedName;
    if (nameToUse) {
      const input = document.getElementById('model-name-input');
      if (input) input.value = nameToUse;
      const banner = document.getElementById('duplicate-warning-banner');
      if (banner) banner.style.display = 'none';
    }
  },

  async quickPreviewModel(modelId) {
    try {
      const model = await API.getModel(modelId);
      const stlFile = (model.files || []).find(f => f.file_type === 'stl' || f.file_type === '3mf' || f.file_type === 'gcode');
      if (stlFile) {
        const fileUrl = stlFile.url || `/uploads/${stlFile.filename}`;
        this.openBrowseFileModal(encodeURIComponent(JSON.stringify({
          name: stlFile.original_name || stlFile.filename,
          type: stlFile.file_type,
          url: fileUrl,
          size: stlFile.file_size
        })));
      } else if (model.thumbnail_url) {
        this.openModal(model.name, `<div style="display:flex;justify-content:center;align-items:center;background:var(--bg-dark);height:400px"><img src="${model.thumbnail_url}" style="max-width:100%;max-height:100%;object-fit:contain"></div>`);
      } else {
        this.navigate(`/models/${modelId}`);
      }
    } catch (e) {
      this.navigate(`/models/${modelId}`);
    }
  },

  confirmDeleteModel(id, name) {
    if (!this.currentUser || this.currentUser.role === 'viewer') {
      return this.toast('Tem de ter sessão iniciada para eliminar modelos', 'error');
    }
    const modelName = name || this.currentModel?.name || '';
    this.openModal('Eliminar Modelo', UI.deleteModelForm(id, modelName));
  },

  async handleDeleteModel(e, id) {
    e.preventDefault();
    const form = new FormData(e.target);
    const deleteDisk = form.get('delete_disk') === 'on';
    try {
      await API.deleteModel(id, deleteDisk);
      this.toast('Modelo eliminado');
      this.closeModal();
      this.navigate('/models');
    } catch (err) { this.toast(err.message, 'error'); }
  },

  copyToClipboard(text, message = 'Copiado') {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => this.toast(message));
    } else {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      textArea.style.top = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        this.toast(message);
      } catch (err) {
        console.error('Falha na cópia alternativa', err);
        this.toast('Falha ao copiar', 'error');
      }
      document.body.removeChild(textArea);
    }
  },

  // ── Ficheiros ──
  showUploadFiles(modelId) {
    this.openModal('Enviar Ficheiros', UI.uploadForm(modelId));
  },

  async handleFileSelect(e, modelId) {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    await this.uploadFilesAction(modelId, files);
  },

  async handleFileDrop(e, modelId) {
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    await this.uploadFilesAction(modelId, files);
  },

  async uploadFilesAction(modelId, files) {
    const MAX_SIZE = 500 * 1024 * 1024; // 500MB
    const tooLarge = files.find(f => f.size > MAX_SIZE);
    if (tooLarge) {
      this.toast(`O ficheiro "${tooLarge.name}" excede o limite de tamanho de 500MB.`, 'error');
      return;
    }
    const progress = document.getElementById('upload-progress');
    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    if (progress) progress.innerHTML = UI.uploadProgressBox({ percent: 0, loaded: 0, total: totalSize, speed: 0, etaSec: 0 });
    
    try {
      await API.uploadFiles(modelId, files, {}, (p) => {
        if (progress) progress.innerHTML = UI.uploadProgressBox(p);
      });
      this.toast(`${files.length} ficheiro(s) enviado(s)`);
      this.closeModal();
      this.renderModelDetail(modelId);
    } catch (e) {
      this.toast(e.message, 'error');
      if (progress) progress.innerHTML = `<div style="color:var(--error);font-size:.875rem;margin-top:8px;display:flex;align-items:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>${e.message}</div>`;
    }
  },

  confirmDeleteFile(fileId, filename, modelId) {
    if (!this.currentUser || this.currentUser.role === 'viewer') {
      return this.toast('Tem de ter sessão iniciada para eliminar ficheiros', 'error');
    }
    this.openModal('Eliminar Ficheiro', UI.deleteFileForm(fileId, filename, modelId));
  },

  async handleDeleteFile(e, fileId, modelId) {
    e.preventDefault();
    const form = new FormData(e.target);
    const deleteDisk = form.get('delete_disk') === 'on';
    try {
      await API.deleteFile(fileId, deleteDisk);
      this.toast('Ficheiro eliminado');
      this.closeModal();
      this.renderModelDetail(modelId);
    } catch (err) { this.toast(err.message, 'error'); }
  },

  async sendToPrinter(fileId) {
    try {
      const config = await API.getSystemSettings();
      let printers = [];
      try { if (config.printers) printers = JSON.parse(config.printers); } catch(e){}
      
      if (printers.length === 0) {
        return this.toast('Nenhuma impressora configurada. Vá a Definições > Impressoras.', 'error');
      }
      
      if (printers.length === 1) {
        this.toast('A enviar para ' + printers[0].name + '...', 'info');
        await API.sendToPrinter(fileId, printers[0].id);
        return this.toast('G-Code enviado com sucesso para ' + printers[0].name);
      }
      
      this.openModal('Enviar para o Moonraker', UI.sendToPrinterForm(fileId, printers));
    } catch(err) {
      this.toast(err.message, 'error');
    }
  },

  async handleSendToPrinter(e, fileId) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const printerId = fd.get('printer_id');
    const select = e.target.querySelector('select');
    const printerName = select.options[select.selectedIndex].text.split(' (')[0];
    try {
      this.toast('A enviar para ' + printerName + '...', 'info');
      this.closeModal();
      await API.sendToPrinter(fileId, printerId);
      this.toast('G-Code enviado com sucesso para ' + printerName);
    } catch (err) { this.toast(err.message, 'error'); }
  },

  // ── Impressões ──
  async showLogPrint(modelId) {
    await this.loadCache();
    this.openModal('Registar Impressão', UI.printForm(modelId, this.cache.materials));
  },

  async handlePrintSubmit(e, modelId) {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await API.addPrint(modelId, {
        material_id: form.get('material_id') || null,
        successful: e.target.querySelector('[name="successful"]').checked,
        notes: form.get('notes'),
        printed_at: form.get('printed_at'),
      });
      this.toast('Impressão registada');
      this.closeModal();
      this.renderModelDetail(modelId);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async deletePrint(printId, modelId) {
    if (!confirm('Eliminar este registo de impressão?')) return;
    try {
      await API.deletePrint(printId);
      this.toast('Registo de impressão eliminado');
      this.renderModelDetail(modelId);
    } catch (e) { this.toast(e.message, 'error'); }
  },

  // ── Itens de Definições ──
  async addSettingsItem(type) {
    const input = document.getElementById(`add-${type}-input`);
    const name = input?.value?.trim();
    if (!name) return;

    try {
      const data = { name };
      if (type === 'categories') {
        data.color = document.getElementById(`add-${type}-color`)?.value || '#8b5cf6';
      }
      if (type === 'categories') await API.createCategory(data);
      else if (type === 'tags') await API.createTag(data);
      else if (type === 'materials') await API.createMaterial(data);

      this.toast(`${type.slice(0,-1)} adicionado(a)`);
      await this.loadCache();
      this.renderSettings();
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async deleteSettingsItem(type, id, name) {
    if (!confirm(`Eliminar "${name}"?`)) return;
    try {
      if (type === 'categories') await API.deleteCategory(id);
      else if (type === 'tags') await API.deleteTag(id);
      else if (type === 'materials') await API.deleteMaterial(id);

      this.toast(`${type.slice(0,-1)} eliminado(a)`);
      await this.loadCache();
      this.renderSettings();
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async handleClearLogs() {
    if (!confirm('Limpar todos os registos do sistema?')) return;
    try {
      await API.clearSystemLogs();
      this.toast('Registos limpos');
      this.switchSettingsTab('system');
    } catch (e) { this.toast(e.message, 'error'); }
  },

  async switchSettingsTab(tab) {
    const tabs = document.querySelectorAll('.settings-tab');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    // Acionar a lógica de mudança já definida em renderSettings
    const activeTab = Array.from(tabs).find(t => t.dataset.tab === tab);
    if (activeTab) activeTab.click();
  },

  async loadBlockedIps() {
    const el = document.getElementById('blocked-ips-list');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem">A carregar IPs bloqueados...</div>';
    try {
      const ips = await API.getBlockedIps();
      if (!ips || ips.length === 0) {
        el.innerHTML = '<div style="color:var(--text-muted);font-size:.85rem;padding:8px 0">Não existem atualmente endereços IP bloqueados.</div>';
        return;
      }
      el.innerHTML = `
        <table class="table" style="width:100%;font-size:.85rem">
          <thead><tr><th>Endereço IP</th><th>Tentativas Falhadas</th><th>Bloqueado Em</th><th>Ação</th></tr></thead>
          <tbody>
            ${ips.map(item => `
              <tr>
                <td><strong>${item.ip}</strong></td>
                <td>${item.attempts}</td>
                <td>${UI.formatDate(item.blockedAt)}</td>
                <td><button type="button" class="btn btn-danger btn-xs" onclick="App.unblockIp('${item.ip}')">Desbloquear</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--error);font-size:.85rem">${e.message || 'Falha ao obter IPs bloqueados'}</div>`;
    }
  },

  async unblockIp(ip) {
    try {
      await API.unblockIp(ip);
      this.toast(`IP ${ip} desbloqueado`);
      this.loadBlockedIps();
    } catch (e) {
      this.toast(e.message, 'error');
    }
  },

  async scanForDuplicates() {
    const el = document.getElementById('duplicates-results');
    if (!el) return;
    el.innerHTML = '<div style="color:var(--accent-cyan);font-size:.85rem">⏳ A analisar a biblioteca usando hashes SHA-256... Aguarde.</div>';
    try {
      const res = await API.scanDuplicates();
      if (!res.groups || res.groups.length === 0) {
        el.innerHTML = '<div style="color:var(--accent-green);font-size:.85rem;padding:8px 0">✓ Ótimas notícias! Não foram encontrados ficheiros de modelos 3D duplicados na sua biblioteca.</div>';
        return;
      }
      el.innerHTML = `
        <div style="margin-bottom:10px;font-weight:600;color:var(--error)">Encontrados ${res.duplicatesCount} grupo(s) de ficheiros idênticos:</div>
        <div style="display:flex;flex-direction:column;gap:12px">
          ${res.groups.map(group => `
            <div style="background:var(--bg-input);padding:12px;border-radius:6px;border:1px solid var(--border)">
              <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:6px">SHA256: <code>${group.hash.substring(0, 16)}...</code> (${UI.formatSize(group.size)})</div>
              <div style="display:flex;flex-direction:column;gap:4px">
                ${group.files.map(f => `
                  <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem">
                    <span style="display:inline-flex;align-items:center;gap:4px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><strong>${f.original_name}</strong> no modelo <a href="#/models/${f.model_id}" style="color:var(--accent-cyan)">${f.model_name || 'Modelo #'+f.model_id}</a></span>
                    <a href="#/models/${f.model_id}" class="btn btn-ghost btn-xs">Ver Modelo</a>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>`;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--error);font-size:.85rem">${e.message || 'Falha ao procurar duplicados'}</div>`;
    }
  }
};

// ── Gestor de Fecho do Overlay Seguro para Arrastar (PR #51) ──
let overlayMouseDownTarget = null;
const modalOverlayEl = document.getElementById('modal-overlay');

if (modalOverlayEl) {
  modalOverlayEl.addEventListener('mousedown', (e) => {
    overlayMouseDownTarget = e.target;
  });

  modalOverlayEl.addEventListener('mouseup', (e) => {
    if (overlayMouseDownTarget === modalOverlayEl && e.target === modalOverlayEl) {
      App.dismissModal();
    }
    overlayMouseDownTarget = null;
  });

  window.addEventListener('mouseup', () => {
    overlayMouseDownTarget = null;
  });
}

// ── Fechar modal com Escape e atalho de pesquisa Ctrl+K ──
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const previewContainer = document.getElementById('preview-modal-container');
    if (previewContainer) {
      App.closePreviewFileModal();
    } else if (document.getElementById('modal-overlay')?.classList.contains('active')) {
      App.dismissModal();
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.focus();
  }
});

// ── Inicializar ──
document.addEventListener('DOMContentLoaded', () => App.init());
